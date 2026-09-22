import { assertFormat, assertRequirements, assertTransport } from './formats.mjs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { assembleParts, extractTarGz } from './archive.mjs';
import { executeWorkflow, validateWorkflow } from './workflow.mjs';
import { handoffProviderFromReference, providerFromConfig } from './providers.mjs';
import { targetFromProfile, validateLocalProfile } from './profiles.mjs';
import { recordInputBatch } from './template.mjs';
import { SessionStore, terminalState } from './session.mjs';
import { ensureDir, nowIso, pathExists, readJson, sha256File } from './util.mjs';

async function providerReadyOrWait(store, session, provider, profile) {
  try { await provider.ready(); return true; }
  catch (error) {
    if (error?.code !== 'AUTH_REQUIRED') throw error;
    session.state = 'waiting_for_auth';
    session.next = { type: 'manual', action: 'google-auth', command: error.authCommand || `workspace-recover auth google-workspace --profile ${profile} --client <oauth-client.json>`, reason: error.message };
    await store.save(session); return false;
  }
}

function expectedFolderId(value) {
  if (!value) return null;
  const text = String(value);
  const folderMatch = text.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];
  return text;
}

/**
 * Execute a fully resolved recovery manifest. This is the single restore engine
 * used both by ordinary restore sessions and backup clean-room rehearsals.
 */
export async function executeRecoveryManifest({
  recovery,
  target,
  sessionDir,
  provider,
  expectedDriveFolder = null,
  operation = 'restore',
  freshDownload = false,
}) {
  if (recovery?.schema !== 'workspace-recover/recovery-manifest/v2') throw new Error('unsupported recovery manifest schema');
  assertRequirements(recovery.requires);
  assertFormat(recovery.transport,'transport-manifest');
  if (!provider) throw new Error('resolved recovery execution requires a provider');
  validateWorkflow(recovery.restore?.workflow || []);
  const safeFileName = value => typeof value === 'string' && value.length > 0 && !['.', '..'].includes(value) && !/[\\/\0]/.test(value) && !/^[A-Za-z]:/.test(value);
  if (!safeFileName(recovery.transport?.archive?.fileName)) throw new Error('unsafe archive filename in recovery manifest');
  const sourceParts = recovery.transport?.parts;
  if (!Array.isArray(sourceParts) || !sourceParts.length) throw new Error('recovery manifest requires transport parts');
  const names = new Set();
  for (let i = 0; i < sourceParts.length; i += 1) {
    const part = sourceParts[i];
    if (!safeFileName(part.fileName) || names.has(part.fileName)) throw new Error('unsafe or duplicate part filename');
    if (part.index !== i) throw new Error('transport part indices must be contiguous and ordered');
    names.add(part.fileName);
  }
  assertTransport(recovery.transport);
  const providerConfig = recovery.transport?.provider || {};
  const expectedFolder = expectedFolderId(expectedDriveFolder || providerConfig.folderId || null);
  if (expectedDriveFolder && providerConfig.folderId && expectedFolderId(providerConfig.folderId) !== expectedFolderId(expectedDriveFolder)) {
    throw new Error('provided Drive folder does not match recovery manifest folder');
  }

  const downloadDir = await ensureDir(path.join(sessionDir, 'downloads'));
  const parts = [];
  for (const part of recovery.transport.parts || []) {
    const downloaded = path.join(downloadDir, part.fileName);
    const reusable = !freshDownload && await pathExists(downloaded)
      && (await fsp.stat(downloaded)).size === part.bytes
      && await sha256File(downloaded) === part.sha256;
    if (!reusable) {
      await fsp.rm(downloaded, { force: true });
      await provider.download(part.remote, downloaded, { expectedFolderId: expectedFolder });
    }
    const stat = await fsp.stat(downloaded);
    if (stat.size !== part.bytes) throw new Error(`download size mismatch: ${part.fileName}`);
    if (await sha256File(downloaded) !== part.sha256) throw new Error(`download hash mismatch: ${part.fileName}`);
    parts.push({ ...part, path: downloaded });
  }

  const archive = path.join(downloadDir, recovery.transport.archive.fileName);
  const assembled = await assembleParts({ parts, output: archive });
  if (assembled.sha256 !== recovery.transport.archive.sha256 || assembled.bytes !== recovery.transport.archive.bytes) {
    throw new Error('assembled recovery archive mismatch');
  }

  const workspace = path.resolve(target);
  await extractTarGz({ archive, destination: workspace, rejectExisting: recovery.restore.existingTarget !== 'merge' });
  const workflow = await executeWorkflow({
    steps: recovery.restore.workflow || [],
    workspace,
    sessionDir: path.join(sessionDir, 'workflow'),
    context: { operation },
  });
  return { workspace, archive, assembled, workflow };
}

export async function startRestore({ handoff, target = null, googleProfile = 'default', expectedDriveFolder = null, stateRoot = null, localProfile = null }) {
  const store = new SessionStore(stateRoot || undefined);
  const session = await store.create('restore', { handoffReference: handoff, inputs: { target }, googleProfile, expectedDriveFolder, localProfile: localProfile ? structuredClone(validateLocalProfile(localProfile)) : null });
  return store.attempt(session, () => resolveAndRunRestore(store, session));
}

export async function startRestoreFromManifest({ manifestPath, target = null, googleProfile = 'default', expectedDriveFolder = null, stateRoot = null, localProfile = null }) {
  const store = new SessionStore(stateRoot || undefined);
  const session = await store.create('restore', { manifestSource: path.resolve(manifestPath), inputs: { target }, googleProfile, expectedDriveFolder, localProfile: localProfile ? structuredClone(validateLocalProfile(localProfile)) : null });
  return store.attempt(session, async () => {
    const raw = await fsp.readFile(manifestPath);
    const recovery = JSON.parse(raw);
    if (recovery.schema !== 'workspace-recover/recovery-manifest/v2') throw new Error('unsupported recovery manifest schema');
    session.recoveryManifestPath = await store.write(session.id, 'selected-recovery-manifest.json', raw);
    session.recoveryManifestSha256 = await sha256File(session.recoveryManifestPath);
    await store.save(session);
    return resolveAndRunRestore(store, session);
  });
}

export async function continueRestore(store, session, setValues = {}) {
  if (terminalState(session.state)) return session;
  if(session.planFrozen && Object.keys(setValues).length)throw new Error('cannot override frozen restore plan inputs; start a new session');
  const unknown=Object.keys(setValues).filter(k=>k!=='target');
  if(unknown.length)throw new Error(`unknown restore input(s): ${unknown.join(', ')}`);
  session.inputs = { ...(session.inputs || {}), ...setValues };
  await store.save(session);
  return store.attempt(session, () => resolveAndRunRestore(store, session));
}

async function resolveAndRunRestore(store, session) {
  if (['completed', 'completed_with_warnings', 'failed'].includes(session.state)) return session;
  if (session.planFrozen) return runRestorePlan(store, session, assertFormat(await readJson(session.planPath),'plan'));
  const sessionDir = store.directory(session.id);
  let recoveryManifestPath = session.recoveryManifestPath;
  if (!recoveryManifestPath) {
    const handoffProvider = handoffProviderFromReference(session.handoffReference, { googleProfile: session.googleProfile });
    if (!await providerReadyOrWait(store, session, handoffProvider, session.googleProfile)) return session;
    const handoffDir = await ensureDir(path.join(sessionDir, 'handoff'));
    const handoff = await handoffProvider.readHandoff(session.handoffReference, handoffDir);
    const indexFile = handoff.attachments['workspace-handoff.json'];
    recoveryManifestPath = handoff.attachments['workspace-recovery-manifest.json'];
    const transportPath = handoff.attachments['workspace-transport-manifest.json'];
    if (!indexFile || !recoveryManifestPath || !transportPath) throw new Error('handoff is missing required recovery attachments');
    const index = assertFormat(await readJson(indexFile),'handoff');
    if (await sha256File(recoveryManifestPath) !== index.recoveryManifestSha256) throw new Error('recovery manifest hash mismatch in handoff');
    assertFormat(await readJson(transportPath),'transport-manifest');
    if (await sha256File(transportPath) !== index.transportManifestSha256) throw new Error('transport manifest hash mismatch in handoff');
    const attachedRecovery=assertFormat(await readJson(recoveryManifestPath),'recovery-manifest');
    const attachedTransport=assertFormat(await readJson(transportPath),'transport-manifest');
    if(JSON.stringify(attachedRecovery.transport)!==JSON.stringify(attachedTransport))throw new Error('handoff transport does not match embedded recovery transport');
    session.recoveryManifestPath = recoveryManifestPath;
    session.handoffIndexPath = indexFile;
    session.handoffId = handoff.id;
    await store.save(session);
  }
  const recovery = await readJson(session.recoveryManifestPath);
  if (recovery.schema !== 'workspace-recover/recovery-manifest/v2') throw new Error('unsupported recovery manifest schema');
  assertRequirements(recovery.requires);assertTransport(recovery.transport);validateWorkflow(recovery.restore?.workflow || []);
  const target = session.inputs?.target ?? recovery.restore?.target?.path ?? targetFromProfile(recovery,session.localProfile);
  const targetSource=session.inputs?.target!=null?'operator-input':recovery.restore?.target?.path!=null?'recovery-manifest':'local-profile';
  if (!target || typeof target!=='string' || target.includes('\0')) {
    return recordInputBatch(store,session,{schema:'workspace-recover/template/v2',name:'restore-inputs',inputs:{target:{type:'path',required:true,description:'New destination directory'}},manifest:{}},{missing:target?[]:['target'],errors:target?[{key:'target',message:'target must be a path string'}]:[],values:{target:target || null},provenance:{}});
  }
  if (!session.planFrozen) {
    const plan = { schema: 'workspace-recover/plan/v2', operation: 'restore', createdAt: nowIso(), handoffId: session.handoffId || null, recoveryManifestSha256: await sha256File(session.recoveryManifestPath), target: path.resolve(target), bindings:{target:{value:path.resolve(target),source:targetSource}}, googleProfile:session.googleProfile, expectedDriveFolder:session.expectedDriveFolder, recoveryManifest: recovery };
    session.planPath = await store.write(session.id, 'plan.json', plan);
    session.planFrozen = true;
    await store.save(session);
  }
  const plan = assertFormat(await readJson(session.planPath),'plan');
  return runRestorePlan(store, session, plan);
}

async function runRestorePlan(store, session, plan) {
  session.state = 'running'; session.next = null; await store.save(session);
  const sessionDir = store.directory(session.id);
  const recovery = plan.recoveryManifest;
  const providerConfig = recovery.transport.provider;
  const provider = providerFromConfig(providerConfig, providerConfig.type === 'google-workspace' ? { profile: plan.googleProfile || session.googleProfile } : {readOnly:true});
  if (!await providerReadyOrWait(store, session, provider, session.googleProfile)) return session;

  const execution = await executeRecoveryManifest({
    recovery,
    target: plan.target,
    sessionDir,
    provider,
    expectedDriveFolder: plan.expectedDriveFolder || session.expectedDriveFolder,
    operation: 'restore',
  });
  const { workspace, assembled, workflow } = execution;
  const restoreReceipt = {
    schema: 'workspace-recover/restore-receipt/v2', sessionId: session.id, target: workspace,
    archiveVerified: true, restoreStatus: 'success', workflowHardFailure: workflow.hardFailure,
    verificationStatus: workflow.advisoryWarnings ? 'warnings' : 'passed', completedAt: nowIso(),
  };
  const receiptPath = await store.write(session.id, 'restore-receipt.json', restoreReceipt);
  const short = `restore success: ${workspace}`;
  const medium = [short, `archiveSha256: ${assembled.sha256}`, `workflow: ${workflow.hardFailure ? 'failed' : 'completed'}`, `verification: ${restoreReceipt.verificationStatus}`].join('\n');
  await store.setInfo(session, 'restore', { short, medium, fullPath: receiptPath });
  await store.setInfo(session, 'verification', workflow.verificationReport);
  await store.setInfo(session, 'workflow', workflow.workflowReport);
  for (const item of workflow.results) {
    if (item.report) await store.setInfo(session, `step:${item.id}`, item.report);
  }
  session.state = workflow.hardFailure ? 'failed' : workflow.advisoryWarnings ? 'completed_with_warnings' : 'completed';
  session.next = { type: 'none' };
  session.result = { restore: 'success', workflow: workflow.hardFailure ? 'failed' : 'completed', verification: restoreReceipt.verificationStatus };
  await store.save(session);
  return session;
}
