import {validateArchiveProfile,prepareBootstrap,packArchive,resolvedArchiveProfile} from './archive-profile.mjs';
import { compileManifest } from './declaration.mjs';
import { assertFormat } from './formats.mjs';
import { createCleanRoom, removeCleanRoom } from './clean-room.mjs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createTarGz, splitFile } from './archive.mjs';
import {validateSelection,selectSource,selectionNul} from './selection.mjs';
import { validateWorkflow } from './workflow.mjs';
import { executeRecoveryManifest } from './restore.mjs';
import { providerFromConfig, providerContext, resourceProvider } from './providers.mjs';
import { INPUT_PROVENANCE, loadTemplate, renderTemplate, recordInputBatch } from './template.mjs';
import { SessionStore, terminalState } from './session.mjs';
import { deepMerge, ensureDir, nowIso, pathExists, readJson, sha256File, sha256Text, writeJsonAtomic, writeTextAtomic } from './util.mjs';

function manifestValidate(manifest) {
  if (manifest?.schema !== 'workspace-recover/manifest/v3') throw new Error('manifest schema must be workspace-recover/manifest/v3');
  if (!manifest.backup?.source?.path) throw new Error('manifest.backup.source.path is required');
  if (!manifest.backup?.provider?.type) throw new Error('manifest.backup.provider.type is required');
  if (!manifest.handoff?.provider?.type) throw new Error('manifest.handoff.provider.type is required');
  if (!manifest.restore) throw new Error('manifest.restore is required');
  validateSelection(manifest.backup.source.include ?? ['**'],manifest.backup.source.exclude ?? []);
  validateWorkflow(manifest.restore.workflow || []);
}

function nextInput(sessionId, missing) {
  return { type: 'manual', action: 'provide-input', required: missing, command: `workspace-recover continue ${sessionId} ${missing.map(key => `--set ${key}=<value>`).join(' ')}` };
}


async function freezePlan(store, session, manifest) {
  manifest=compileManifest(manifest);
  manifestValidate(manifest);
  const manifestPath = await store.write(session.id, 'manifest.json', manifest);
  const manifestText = await fsp.readFile(manifestPath, 'utf8');
  const plan = {
    schema: 'workspace-recover/plan/v3',
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

export async function startBackupFromManifest({ manifestPath, stateRoot = null, execution = {} }) {
  const store = new SessionStore(stateRoot || undefined);
  const session = await store.create('backup', { manifestSource: path.resolve(manifestPath), inputs: {}, execution });
  return store.attempt(session, async () => {
    const manifest = await readJson(manifestPath);
    const plan = await freezePlan(store, session, manifest);
    return runBackupPlan(store, session, plan);
  });
}

export async function startBackup({ templatePath, values, stateRoot = null, execution = {} }) {
  const store = new SessionStore(stateRoot || undefined);
  const session = await store.create('backup', { execution, templateSource: path.resolve(templatePath), inputs: values || {}, inputProvenance: values?.[INPUT_PROVENANCE] || {} });
  return store.attempt(session, async () => {
    const template = await loadTemplate(templatePath);
    await store.write(session.id, 'template.json', template);
    await store.write(session.id, 'values.json', {schema:'workspace-recover/values/v3',values:values || {}});
    return resolveAndRunBackup(store, session, template, values || {});
  });
}

export async function continueBackup(store, session, setValues = {}) {
  if (terminalState(session.state)) return session;
  return store.attempt(session, async () => {
    // Frozen plans are independent of mutable author files and generators.
    if (session.planFrozen && Object.keys(setValues).length) throw new Error('frozen plan cannot be overwritten; start a new session');
    if (session.planFrozen) return runBackupPlan(store, session, assertFormat(await readJson(session.planPath),'plan'));
    const template = await readJson(path.join(store.directory(session.id), 'template.json'));
    const priorDocument = await readJson(path.join(store.directory(session.id), 'values.json'));
    if (priorDocument.schema !== 'workspace-recover/values/v3') throw new Error('unsupported values schema');
    const priorValues=priorDocument.values;
    const values = deepMerge(priorValues, setValues);
    for (const [k,v] of Object.entries(setValues[INPUT_PROVENANCE] || {})) (session.inputProvenance[k]??=[]).push(...v);
    await store.write(session.id, 'values.json', {schema:'workspace-recover/values/v3',values});
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
  if(terminalState(session.state))return session;
  session.state='running';session.next=null;session.progress??={};await store.save(session);
  const manifest=plan.manifest, progress=session.progress, sessionDir=store.directory(session.id);
  const provider=providerFromConfig(manifest.backup.provider,providerContext(store,session,'artifacts',['drive.upload','drive.download'],session.execution));
  const mail=providerFromConfig(manifest.handoff.provider,providerContext(store,session,'handoff',['gmail.send','gmail.read'],session.execution));
  if(!await providerReadyOrWait(store,session,provider)||!await providerReadyOrWait(store,session,mail))return session;
  const artifactDir=await ensureDir(path.join(sessionDir,'artifacts'));
  const archivePath=path.join(artifactDir,'workspace-backup.'+(manifest.archiveProfile?.format||'tar.gz'));
  if(!progress.bootstrap){progress.bootstrap=await prepareBootstrap(manifest.archiveProfile,sessionDir);await store.save(session);}
  if(!progress.archive) {
    const selection=await selectSource({source:manifest.backup.source.path,includes:manifest.backup.source.include??['**'],excludes:manifest.backup.source.exclude??[]});
    await fsp.writeFile(path.join(sessionDir,'selected-files.nul'),selectionNul(selection),{flag:'wx',mode:0o600});
    const captured=await packArchive({profile:manifest.archiveProfile,source:manifest.backup.source.path,output:archivePath,selection,selectionFile:path.join(sessionDir,'selected-files.nul'),sessionDir,bootstrap:progress.bootstrap});
    if(captured.packReport){await store.setInfo(session,'pack',captured.packReport);delete captured.packReport;}
    const inventoryPath=await store.write(session.id,'selection-manifest.json',captured.inventory);
    progress.inventory={path:inventoryPath,bytes:(await fsp.stat(inventoryPath)).size,sha256:await sha256File(inventoryPath)};
    const t=captured.inventory.totals;
    await store.setInfo(session,'selection',{short:`${t.files} file(s), ${t.entries} entries, ${t.bytes} bytes`,medium:`files=${t.files}; entries=${t.entries}; bytes=${t.bytes}\ninclude=${JSON.stringify(selection.patterns.include)}\nexclude=${JSON.stringify(selection.patterns.exclude)}\nvisited=${t.visited}; excludedRoots=${t.excludedRoots}\nInventory: ${inventoryPath}`,fullPath:inventoryPath});
    delete captured.inventory;progress.archive=captured;await store.save(session);
  } else if(!await pathExists(archivePath)||await sha256File(archivePath)!==progress.archive.sha256)throw new Error('captured archive changed or disappeared; do not recapture a frozen backup');
  if(!progress.parts) {progress.parts=await splitFile({file:archivePath,outputDirectory:path.join(artifactDir,'parts'),maxPartBytes:manifest.backup.transport?.partSizeBytes||64*1024*1024});await store.save(session);}
  progress.uploadedParts??=[];
  const uploads=await Promise.allSettled([...progress.bootstrap.map(async b=>{if(!b.remote){b.remote=await provider.upload(b.path,{name:`workspace-recover-${session.id}-bootstrap-${b.id}`,folderId:manifest.backup.provider.folderId});await store.save(session);}}),...progress.parts.map(async part=>{
    if(progress.uploadedParts[part.index]?.id)return;
    const remote=await provider.upload(part.path,{name:`${session.id}-${part.fileName}`,folderId:manifest.backup.provider.folderId});
    progress.uploadedParts[part.index]={...remote,index:part.index,bytes:part.bytes,sha256:part.sha256,fileName:part.fileName};await store.save(session);
  }), (async()=>{
    if(!progress.selectionRemote){progress.selectionRemote=await provider.upload(progress.inventory.path,{name:`workspace-recover-${session.id}-selection.json`,folderId:manifest.backup.provider.folderId});await store.save(session);}
  })()]);
  const failed=uploads.find(x=>x.status==='rejected');if(failed)throw failed.reason;
  const transport={schema:'workspace-recover/transport-manifest/v3',archive:{fileName:path.basename(archivePath),bytes:progress.archive.bytes,sha256:progress.archive.sha256,format:manifest.archiveProfile?.format||'tar.gz'},
    provider:resourceProvider(manifest.backup.provider),parts:progress.uploadedParts.map(p=>({index:p.index,fileName:p.fileName,bytes:p.bytes,sha256:p.sha256,remote:{id:p.id,url:p.url,parent:p.parent}}))};
  const transportPath=await store.write(session.id,'transport-manifest.json',transport);
  if(!progress.transportRemote){progress.transportRemote=await provider.upload(transportPath,{name:`workspace-recover-${session.id}-transport-manifest.json`,folderId:manifest.backup.provider.folderId});await store.save(session);}
  if(!progress.transportReadback){const out=path.join(sessionDir,'transport-readback.json');await provider.download(progress.transportRemote,out,{expectedFolderId:manifest.backup.provider.folderId,expectedBytes:(await fsp.stat(transportPath)).size,expectedSha256:await sha256File(transportPath)});if(await sha256File(out)!==await sha256File(transportPath))throw new Error('transport manifest provider roundtrip mismatch');progress.transportReadback=true;await store.save(session);}
  const recoveryPath=path.join(sessionDir,'workspace-recovery-manifest.json');
  let recovery;
  if(progress.recoveryManifestSha256) {
    if(await sha256File(recoveryPath)!==progress.recoveryManifestSha256)throw new Error('frozen recovery manifest changed');recovery=await readJson(recoveryPath);
  } else {
    recovery={...(manifest.archiveProfile?{archiveProfile:resolvedArchiveProfile(manifest.archiveProfile,progress.bootstrap)}:{}),schema:'workspace-recover/recovery-manifest/v3',backupSessionId:session.id,createdAt:nowIso(),transport,selection:{bytes:progress.inventory.bytes,sha256:progress.inventory.sha256,remote:{id:progress.selectionRemote.id,url:progress.selectionRemote.url,parent:progress.selectionRemote.parent}},
      requires:{formatVersion:3,features:[...new Set([...(manifest.requires?.features||[]),'pax-paths','selection-inventory',...(manifest.archiveProfile?['archive-profiles']:['safe-merge'])])]},project:{name:manifest.name||'workspace'},
      restore:{existingTarget:manifest.restore.existingTarget||'reject',target:manifest.restore.target||{required:true},workflow:manifest.restore.workflow||[]}};
    await store.write(session.id,'workspace-recovery-manifest.json',recovery);progress.recoveryManifestSha256=await sha256File(recoveryPath);await store.save(session);
  }
  const rehearsalReceiptPath=path.join(sessionDir,'rehearsal-receipt.json');
  const rehearsalResultPath=path.join(sessionDir,'rehearsal-result.json');
  let execution,receipt;
  if(progress.rehearsalCompleted) {execution=await readJson(rehearsalResultPath);receipt=await readJson(rehearsalReceiptPath);}
  else {
    if(!progress.rehearsal){const root=await createCleanRoom(session.id);progress.rehearsal={cleanRoom:root,workspace:path.join(root,'workspace'),state:'running'};await store.save(session);}
    const root=progress.rehearsal.cleanRoom;
    try {
      execution=await executeRecoveryManifest({recovery,target:progress.rehearsal.workspace,sessionDir:path.join(sessionDir,'rehearsal'),provider,expectedDriveFolder:manifest.backup.provider.folderId||null,operation:'rehearsal',freshDownload:true});
    }catch(error){
      if(['EXTERNAL_PENDING','CAPABILITY_REQUIRED','EXTERNAL_OUTCOME_UNKNOWN'].includes(error?.code))throw error;
      progress.rehearsal.state='failed';await store.write(session.id,'rehearsal-receipt.json',{schema:'workspace-recover/rehearsal-receipt/v3',sessionId:session.id,cleanRoom:root,cleanRoomPreserved:await pathExists(root),restoreStatus:'failed',verificationStatus:'not_run',error:error.message,completedAt:nowIso()});throw error;
    }
    const clean=!execution.workflow.hardFailure&&!execution.workflow.advisoryWarnings;
    receipt={schema:'workspace-recover/rehearsal-receipt/v3',sessionId:session.id,cleanRoom:root,restoreStatus:'success',verificationStatus:execution.workflow.advisoryWarnings?'warnings':'passed',workflowHardFailure:execution.workflow.hardFailure,cleanRoomPreserved:!clean,completedAt:nowIso()};
    await store.write(session.id,'rehearsal-result.json',execution);
    if(clean){await removeCleanRoom(root);receipt.cleanRoom=null;}
    await store.write(session.id,'rehearsal-receipt.json',receipt);progress.rehearsal.state=clean?'completed':'completed_with_warnings';progress.rehearsal.cleanRoom=receipt.cleanRoom;progress.rehearsalCompleted=true;await store.save(session);
  }
  const workflow=execution.workflow;
  if(execution.unpackReport)await store.setInfo(session,'unpack',execution.unpackReport);
  const backupReceiptPath=path.join(sessionDir,'backup-receipt.json');
  if(!progress.backupReceiptWritten){await store.write(session.id,'backup-receipt.json',{schema:'workspace-recover/backup-receipt/v3',sessionId:session.id,archive:transport.archive,transportManifestRemote:progress.transportRemote,freshProviderRoundtripVerified:true,recoveryRehearsal:receipt,completedAt:nowIso()});progress.backupReceiptWritten=true;await store.save(session);}
  const backupReceipt=await readJson(backupReceiptPath);
  // Publish the exact externally consumable manifest only after it was rehearsed.
  if(!progress.recoveryRemote){progress.recoveryRemote=await provider.upload(recoveryPath,{name:`workspace-recover-${session.id}-recovery-manifest.json`,folderId:manifest.backup.provider.folderId});await store.save(session);}
  if(!progress.recoveryReadback){const out=path.join(sessionDir,'recovery-manifest-readback.json');await provider.download(progress.recoveryRemote,out,{expectedFolderId:manifest.backup.provider.folderId,expectedBytes:(await fsp.stat(recoveryPath)).size,expectedSha256:progress.recoveryManifestSha256});if(await sha256File(out)!==progress.recoveryManifestSha256)throw new Error('recovery manifest provider roundtrip mismatch');progress.recoveryReadback=true;await store.save(session);}
  const handoffIndex={schema:'workspace-recover/handoff/v3',backupSessionId:session.id,recoveryManifestSha256:progress.recoveryManifestSha256,transportManifestSha256:await sha256File(transportPath),backupReceiptSha256:await sha256File(backupReceiptPath),rehearsalReceiptSha256:await sha256File(rehearsalReceiptPath)};
  const indexPath=await store.write(session.id,'workspace-handoff.json',handoffIndex);
  const attachments=[['workspace-handoff.json',indexPath],['workspace-recovery-manifest.json',recoveryPath],['workspace-transport-manifest.json',transportPath],['workspace-backup-receipt.json',backupReceiptPath],['workspace-rehearsal-receipt.json',rehearsalReceiptPath]].map(([name,file])=>({name,path:file,mimeType:'application/json'}));
  const context={sessionId:session.id,projectName:manifest.name||'workspace',archiveSha256:transport.archive.sha256,archiveBytes:String(transport.archive.bytes),archiveLinks:transport.parts.map(p=>p.remote.url||p.remote.id).join('\n'),recoveryManifestUrl:progress.recoveryRemote.url||progress.recoveryRemote.id,rehearsal:workflow.hardFailure?'failed':'success',verification:workflow.advisoryWarnings?'warnings':'passed'};
  const defaultBody='workspace-recover backup session: {{sessionId}}\nProject: {{projectName}}\nRecovery rehearsal: {{rehearsal}}\nVerification: {{verification}}\nArchive bytes: {{archiveBytes}}\nArchive SHA256: {{archiveSha256}}\n\n{{archiveLinks}}\nRecovery manifest: {{recoveryManifestUrl}}\n\nMore: workspace-recover info {{sessionId}}';
  const body=(manifest.handoff.bodyTemplate||defaultBody).replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g,(_,key)=>{if(!(key in context))throw new Error(`unknown mail template placeholder: ${key}`);return context[key];});
  const subject=manifest.handoff.subject||`workspace-recover handoff ${session.id}`;
  if(!progress.handoff){progress.handoff=await mail.sendHandoff({sessionId:session.id,to:manifest.handoff.to,subject,body,attachments});await store.save(session);}
  const handoff=progress.handoff;
  const attachmentHashes=Object.fromEntries(await Promise.all(attachments.map(async a=>[a.name,await sha256File(a.path)])));
  const readback=await verifyHandoffReadback(mail,handoff,{readbackDir:path.join(sessionDir,'handoff-readback'),attachmentHashes});
  if(readback.subject!==undefined && readback.subject!==subject)throw new Error('Gmail readback subject mismatch');
  if(readback.to!==undefined){const list=x=>(Array.isArray(x)?x:String(x).split(',')).map(s=>s.trim().toLowerCase()).sort().join(',');if(list(readback.to)!==list(manifest.handoff.to||[]))throw new Error('Gmail readback recipients mismatch');}
  if(typeof readback.body==='string' && readback.body.replaceAll('\r\n','\n').trimEnd()!==body.trimEnd())throw new Error('handoff body readback mismatch');
  const handoffReport=await store.write(session.id,'reports/handoff/primary.json',{id:readback.id,url:handoff.url,readbackVerified:true,attachments:readback.attachments,attachmentHashes});
  const backupReport=await store.write(session.id,'reports/backup/primary.json',{backupReceipt,handoff,readbackVerified:true});
  const short=`${transport.parts.length} part(s), ${transport.archive.bytes} bytes, provider roundtrip verified`;
  await store.setInfo(session,'backup',{short,medium:`${short}\narchiveSha256: ${transport.archive.sha256}\nhandoff: ${handoff.url||handoff.id}\nrehearsal: ${receipt.restoreStatus}\nverification: ${receipt.verificationStatus}`,fullPath:backupReport});
  for(const name of ['verification','workflow'])await store.setInfo(session,name,workflow[`${name}Report`]);
  for(const r of workflow.results)if(r.report)await store.setInfo(session,`step:${r.id}`,r.report);
  await store.setInfo(session,'handoff',{short:`handoff sent/read back: ${handoff.id}`,medium:`${handoff.url||handoff.id}\nattachments=${attachments.length}`,fullPath:handoffReport});
  session.handoff=handoff;session.state=workflow.hardFailure?'failed':workflow.advisoryWarnings?'completed_with_warnings':'completed';session.next={type:'none'};
  session.result={backup:'created',recoveryRehearsal:workflow.hardFailure?'failed':'success',verification:workflow.advisoryWarnings?'warnings':'passed'};await store.save(session);return session;
}
