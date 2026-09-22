import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createTarGz, splitFile } from './archive.mjs';
import { validateWorkflow } from './workflow.mjs';
import { executeRecoveryManifest } from './restore.mjs';
import { providerFromConfig } from './providers.mjs';
import { INPUT_PROVENANCE, loadTemplate, renderTemplate, recordInputBatch } from './template.mjs';
import { SessionStore, terminalState } from './session.mjs';
import { deepMerge, ensureDir, nowIso, pathExists, readJson, sha256File, sha256Text, writeJsonAtomic, writeTextAtomic } from './util.mjs';

function manifestValidate(manifest) {
  if (manifest?.schema !== 'workspace-recover/manifest/v2') throw new Error('manifest schema must be workspace-recover/manifest/v2');
  if (!manifest.backup?.source?.path) throw new Error('manifest.backup.source.path is required');
  if (!manifest.backup?.provider?.type) throw new Error('manifest.backup.provider.type is required');
  if (!manifest.handoff?.provider?.type) throw new Error('manifest.handoff.provider.type is required');
  if (!manifest.restore) throw new Error('manifest.restore is required');
  validateWorkflow(manifest.restore.workflow || []);
}

function nextInput(sessionId, missing) {
  return { type: 'manual', action: 'provide-input', required: missing, command: `workspace-recover continue ${sessionId} ${missing.map(key => `--set ${key}=<value>`).join(' ')}` };
}


async function freezePlan(store, session, manifest) {
  manifestValidate(manifest);
  const manifestPath = await store.write(session.id, 'manifest.json', manifest);
  const manifestText = await fsp.readFile(manifestPath, 'utf8');
  const plan = {
    schema: 'workspace-recover/plan/v2',
    operation: 'backup',
    createdAt: nowIso(),
    manifestSha256: sha256Text(manifestText),
    manifest,
    inputProvenance: session.inputProvenance || {},
  };
  const planPath = await store.write(session.id, 'plan.json', plan);
  session.planPath = planPath;
  session.manifestPath = manifestPath;
  session.planFrozen = true;
  await store.save(session);
  return plan;
}

async function providerReadyOrWait(store, session, provider) {
  try {
    await provider.ready();
    return true;
  } catch (error) {
    if (error?.code !== 'AUTH_REQUIRED') throw error;
    session.state = 'waiting_for_auth';
    session.next = { type: 'manual', action: 'google-auth', command: error.authCommand, reason: error.message };
    await store.save(session);
    return false;
  }
}

async function verifyHandoffReadback(provider, handoff, expected) {
  const readback = await provider.readHandoff(handoff.url || handoff.id, expected.readbackDir);
  for (const [name, sha] of Object.entries(expected.attachmentHashes)) {
    const file = readback.attachments[name];
    if (!file) throw new Error(`handoff readback is missing attachment ${name}`);
    if (await sha256File(file) !== sha) throw new Error(`handoff readback sha256 mismatch for ${name}`);
  }
  return readback;
}

export async function startBackupFromManifest({ manifestPath, stateRoot = null }) {
  const store = new SessionStore(stateRoot || undefined);
  const session = await store.create('backup', { manifestSource: path.resolve(manifestPath), inputs: {} });
  return store.attempt(session, async () => {
    const manifest = await readJson(manifestPath);
    const plan = await freezePlan(store, session, manifest);
    return runBackupPlan(store, session, plan);
  });
}

export async function startBackup({ templatePath, values, stateRoot = null }) {
  const store = new SessionStore(stateRoot || undefined);
  const session = await store.create('backup', { templateSource: path.resolve(templatePath), inputs: values || {}, inputProvenance: values?.[INPUT_PROVENANCE] || {} });
  return store.attempt(session, async () => {
    const template = await loadTemplate(templatePath);
    await store.write(session.id, 'template.json', template);
    await store.write(session.id, 'values.json', {schema:'workspace-recover/values/v2',values:values || {}});
    return resolveAndRunBackup(store, session, template, values || {});
  });
}

export async function continueBackup(store, session, setValues = {}) {
  if (terminalState(session.state)) return session;
  return store.attempt(session, async () => {
    // Frozen plans are independent of mutable author files and generators.
    if (session.planFrozen && Object.keys(setValues).length) throw new Error('frozen plan cannot be overwritten; start a new session');
    if (session.planFrozen) return runBackupPlan(store, session, await readJson(session.planPath));
    const template = await readJson(path.join(store.directory(session.id), 'template.json'));
    const priorDocument = await readJson(path.join(store.directory(session.id), 'values.json'));
    if (priorDocument.schema !== 'workspace-recover/values/v2') throw new Error('unsupported values schema');
    const priorValues=priorDocument.values;
    const values = deepMerge(priorValues, setValues);
    for (const [k,v] of Object.entries(setValues[INPUT_PROVENANCE] || {})) (session.inputProvenance[k]??=[]).push(...v);
    await store.write(session.id, 'values.json', {schema:'workspace-recover/values/v2',values});
    return resolveAndRunBackup(store, session, template, values);
  });
}

async function resolveAndRunBackup(store, session, template, values) {
  const rendered = await renderTemplate(template, values, session.inputProvenance);
  session.inputs = rendered.values;
  session.inputProvenance=rendered.provenance;
  if (rendered.missing.length || rendered.errors.length) return recordInputBatch(store, session, template, rendered);
  const plan = await freezePlan(store, session, rendered.manifest);
  return runBackupPlan(store, session, plan);
}

async function runBackupPlan(store, session, plan) {
  if (['completed', 'completed_with_warnings', 'failed'].includes(session.state)) return session;
  session.state = 'running';
  session.next = null;
  await store.save(session);
  const manifest = plan.manifest;
  const sessionDir = store.directory(session.id);
  const provider = providerFromConfig(manifest.backup.provider);
  if (!await providerReadyOrWait(store, session, provider)) return session;
  const handoffProvider = providerFromConfig(manifest.handoff.provider);
  if (!await providerReadyOrWait(store, session, handoffProvider)) return session;

  const artifactDir = await ensureDir(path.join(sessionDir, 'artifacts'));
  const archivePath = path.join(artifactDir, 'workspace-backup.tar.gz');
  let archiveInfo = session.progress?.archive;
  if (!archiveInfo || !await pathExists(archivePath) || await sha256File(archivePath) !== archiveInfo.sha256) {
    archiveInfo = await createTarGz({
      source: path.resolve(manifest.backup.source.path),
      output: archivePath,
      excludes: manifest.backup.source.exclude || [],
    });
    session.progress = { ...(session.progress || {}), archive: archiveInfo };
    await store.save(session);
  }

  const partDir = path.join(artifactDir, 'parts');
  let parts = session.progress?.parts;
  if (!parts?.length) {
    parts = await splitFile({ file: archivePath, outputDirectory: partDir, maxPartBytes: manifest.backup.transport?.partSizeBytes || 64 * 1024 * 1024 });
    session.progress.parts = parts;
    await store.save(session);
  }

  let uploadedParts = session.progress?.uploadedParts || [];
  for (const part of parts) {
    if (uploadedParts[part.index]?.id) continue;
    const remote = await provider.upload(part.path, { name: `${session.id}-${part.fileName}`, folderId: manifest.backup.provider.folderId });
    uploadedParts[part.index] = { ...remote, index: part.index, bytes: part.bytes, sha256: part.sha256, fileName: part.fileName };
    session.progress.uploadedParts = uploadedParts;
    await store.save(session);
  }

  const transport = {
    schema: 'workspace-recover/transport-manifest/v2',
    archive: { fileName: path.basename(archivePath), bytes: archiveInfo.bytes, sha256: archiveInfo.sha256, format: 'tar.gz' },
    provider: manifest.backup.provider,
    parts: uploadedParts.map(item => ({ index: item.index, fileName: item.fileName, bytes: item.bytes, sha256: item.sha256, remote: { id: item.id, url: item.url, parent: item.parent } })),
  };
  const transportPath = await store.write(session.id, 'transport-manifest.json', transport);
  let transportRemote = session.progress?.transportRemote;
  if (!transportRemote?.id) {
    transportRemote = await provider.upload(transportPath, { name: `workspace-recover-${session.id}-transport-manifest.json`, folderId: manifest.backup.provider.folderId });
    session.progress.transportRemote = transportRemote;
    await store.save(session);
  }

  const recoveryManifest = {
    schema: 'workspace-recover/recovery-manifest/v2',
    backupSessionId: session.id,
    createdAt: nowIso(),
    transport,
    restore: {
      existingTarget: manifest.restore.existingTarget || 'reject',
      target: manifest.restore.target || { required: true },
      workflow: manifest.restore.workflow || [],
    },
  };
  const recoveryManifestPath = await store.write(session.id, 'workspace-recovery-manifest.json', recoveryManifest);

  const cleanRoot = path.join(os.tmpdir(), `workspace-recover-clean-room-${session.id}-${crypto.randomBytes(4).toString('hex')}`);
  const cleanWorkspace = path.join(cleanRoot, 'workspace');
  session.progress.rehearsal = { cleanRoom: cleanRoot, workspace: cleanWorkspace, state: 'running' };
  await store.save(session);
  let rehearsalExecution;
  try {
    rehearsalExecution = await executeRecoveryManifest({
    recovery: recoveryManifest,
    target: cleanWorkspace,
    sessionDir: path.join(sessionDir, 'rehearsal'),
    provider,
    expectedDriveFolder: manifest.backup.provider.folderId || null,
    operation: 'rehearsal',
    freshDownload: true,
    });
  } catch (error) {
    session.progress.rehearsal.state = 'failed';
    await store.write(session.id, 'rehearsal-receipt.json', {
      schema: 'workspace-recover/rehearsal-receipt/v2', sessionId: session.id,
      cleanRoom: cleanRoot, cleanRoomPreserved: await pathExists(cleanRoot),
      restoreStatus: 'failed', verificationStatus: 'not_run', error: error.message, completedAt: nowIso(),
    });
    throw error;
  }
  const rehearsalWorkflow = rehearsalExecution.workflow;
  const rehearsalClean = !rehearsalWorkflow.hardFailure && !rehearsalWorkflow.advisoryWarnings;
  const rehearsalReceipt = {
    schema: 'workspace-recover/rehearsal-receipt/v2',
    sessionId: session.id,
    cleanRoom: cleanRoot,
    restoreStatus: 'success',
    verificationStatus: rehearsalWorkflow.advisoryWarnings ? 'warnings' : 'passed',
    workflowHardFailure: rehearsalWorkflow.hardFailure,
    cleanRoomPreserved: !rehearsalClean,
    completedAt: nowIso(),
  };
  if (rehearsalClean) {
    await fsp.rm(cleanRoot, { recursive: true, force: true });
    rehearsalReceipt.cleanRoom = null;
  }
  session.progress.rehearsal.state = rehearsalClean ? 'completed' : 'completed_with_warnings';
  session.progress.rehearsal.cleanRoom = rehearsalReceipt.cleanRoom;
  const rehearsalReceiptPath = await store.write(session.id, 'rehearsal-receipt.json', rehearsalReceipt);

  const backupReceipt = {
    schema: 'workspace-recover/backup-receipt/v2',
    sessionId: session.id,
    archive: transport.archive,
    transportManifestRemote: transportRemote,
    freshProviderRoundtripVerified: true,
    recoveryRehearsal: rehearsalReceipt,
    completedAt: nowIso(),
  };
  const backupReceiptPath = await store.write(session.id, 'backup-receipt.json', backupReceipt);
  const handoffIndex = {
    schema: 'workspace-recover/handoff/v2',
    backupSessionId: session.id,
    recoveryManifestSha256: await sha256File(recoveryManifestPath),
    transportManifestSha256: await sha256File(transportPath),
    backupReceiptSha256: await sha256File(backupReceiptPath),
    rehearsalReceiptSha256: await sha256File(rehearsalReceiptPath),
  };
  const handoffIndexPath = await store.write(session.id, 'workspace-handoff.json', handoffIndex);
  const attachments = [
    { name: 'workspace-handoff.json', path: handoffIndexPath, mimeType: 'application/json' },
    { name: 'workspace-recovery-manifest.json', path: recoveryManifestPath, mimeType: 'application/json' },
    { name: 'workspace-transport-manifest.json', path: transportPath, mimeType: 'application/json' },
    { name: 'workspace-backup-receipt.json', path: backupReceiptPath, mimeType: 'application/json' },
    { name: 'workspace-rehearsal-receipt.json', path: rehearsalReceiptPath, mimeType: 'application/json' },
  ];
  const body = [
    `workspace-recover backup session: ${session.id}`,
    `Recovery rehearsal: ${rehearsalWorkflow.hardFailure ? 'failed' : 'success'}`,
    `Verification: ${rehearsalWorkflow.advisoryWarnings ? 'warnings' : 'passed'}`,
    `Archive SHA256: ${transport.archive.sha256}`,
    '',
    `More: workspace-recover info ${session.id}`,
  ].join('\n');
  const handoff = await handoffProvider.sendHandoff({
    sessionId: session.id,
    to: manifest.handoff.to,
    subject: manifest.handoff.subject || `workspace-recover handoff ${session.id}`,
    body,
    attachments,
  });
  const attachmentHashes = Object.fromEntries(await Promise.all(attachments.map(async item => [item.name, await sha256File(item.path)])));
  const readbackDir = path.join(sessionDir, 'handoff-readback');
  const handoffReadback = await verifyHandoffReadback(handoffProvider, handoff, { readbackDir, attachmentHashes });
  const handoffReportPath = await store.write(session.id, 'reports/handoff/primary.json', {
    id: handoffReadback.id, url: handoff.url, readbackVerified: true, attachments: handoffReadback.attachments, attachmentHashes,
  });

  const backupInfoPath = path.join(sessionDir, 'reports', 'backup', 'primary.json');
  await ensureDir(path.dirname(backupInfoPath));
  await writeJsonAtomic(backupInfoPath, { backupReceipt, handoff, readbackVerified: true });
  const backupShort = `${transport.parts.length} part(s), ${transport.archive.bytes} bytes, provider roundtrip verified`;
  const backupMedium = [backupShort, `archiveSha256: ${transport.archive.sha256}`, `handoff: ${handoff.url || handoff.id}`, `rehearsal: ${rehearsalReceipt.restoreStatus}`, `verification: ${rehearsalReceipt.verificationStatus}`].join('\n');
  await store.setInfo(session, 'backup', { short: backupShort, medium: backupMedium, fullPath: backupInfoPath });
  await store.setInfo(session, 'verification', rehearsalWorkflow.verificationReport);
  await store.setInfo(session, 'workflow', rehearsalWorkflow.workflowReport);
  for (const item of rehearsalWorkflow.results) {
    if (item.report) await store.setInfo(session, `step:${item.id}`, item.report);
  }
  await store.setInfo(session, 'handoff', { short: `handoff sent/read back: ${handoff.id}`, medium: `${handoff.url || handoff.id}\nattachments=${attachments.length}`, fullPath: handoffReportPath });
  session.handoff = handoff;
  session.state = rehearsalWorkflow.hardFailure ? 'failed' : rehearsalWorkflow.advisoryWarnings ? 'completed_with_warnings' : 'completed';
  session.next = { type: 'none' };
  session.result = { backup: 'created', recoveryRehearsal: rehearsalWorkflow.hardFailure ? 'failed' : 'success', verification: rehearsalWorkflow.advisoryWarnings ? 'warnings' : 'passed' };
  await store.save(session);
  return session;
}
