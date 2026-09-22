import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBackupFromManifest } from '../src/core/backup.mjs';
import { renderTemplate } from '../src/core/template.mjs';
import { readJson, pathExists } from '../src/core/util.mjs';
import { executeWorkflow } from '../src/core/workflow.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'bin/workspace-recover.mjs');
async function fixture(t){
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wr-public-test-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source');await fsp.mkdir(source);await fsp.writeFile(path.join(source,'data'),'version1');
 const manifest={schema:'workspace-recover/manifest/v2',backup:{source:{path:source},provider:{type:'local-files',root:path.join(root,'objects')}},restore:{existingTarget:'reject',workflow:[]},handoff:{provider:{type:'local-files',root:path.join(root,'objects')},subject:'rebranding'}};
 const manifestPath=path.join(root,'backup.json');await fsp.writeFile(manifestPath,JSON.stringify(manifest));
 return {root,source,manifest,manifestPath,stateRoot:path.join(root,'state')};
}

test('operator can restore an explicitly edited manifest without altering old handoff or plan',async t=>{
 const f=await fixture(t);const backup=await startBackupFromManifest(f);
 const original=path.join(new URL(backup.handoff.url).pathname,'workspace-recovery-manifest.json');const bytes=await fsp.readFile(original);
 const edited=JSON.parse(bytes);edited.restore.workflow=[{id:'operator-chosen',type:'verification',argv:[process.execPath,'-e',"require('fs').writeFileSync('operator.marker','yes')"]}];
 const chosen=path.join(f.root,'edited-recovery.json');await fsp.writeFile(chosen,JSON.stringify(edited));
 const target=path.join(f.root,'restored');const proc=spawnSync(process.execPath,[CLI,'restore','--manifest',chosen,'--target',target,'--state-dir',f.stateRoot],{encoding:'utf8'});
 assert.equal(proc.status,0,proc.stdout+proc.stderr);assert.match(proc.stdout,/State: completed/);
 assert.equal(await fsp.readFile(path.join(target,'operator.marker'),'utf8'),'yes');assert.deepEqual(await fsp.readFile(original),bytes);
});

test('runtime workflow placeholders are deferred without requesting them as operator inputs',async()=>{
 const template={schema:'workspace-recover/template/v2',inputs:{sourcePath:{required:true,type:'string'}},manifest:{schema:'workspace-recover/manifest/v2',backup:{source:{path:'${sourcePath}'}},restore:{workflow:[{id:'x',type:'command',argv:['node','check.mjs','${workspace}','${stepDir}','${operation}']}]}}};
 const r=await renderTemplate(template,{sourcePath:'/declared-source'});assert.deepEqual(r.missing,[]);
 assert.equal(r.manifest.restore.workflow[0].argv[2],'${workspace}');
});

test('declared input types are checked, not silently converted',async()=>{
 const template={schema:'workspace-recover/template/v2',inputs:{partSizeBytes:{required:true,type:'integer'}},manifest:{size:'${partSizeBytes}'}};
 const r=await renderTemplate(template,{partSizeBytes:'not a number'});assert.equal(r.errors.length,1);assert.match(r.errors[0].message,/partSizeBytes.*integer/);
});

test('invalid later workflow step is found before executing earlier steps',async t=>{
 const f=await fixture(t);const marker=path.join(f.source,'must-not-run');
 await assert.rejects(()=>executeWorkflow({workspace:f.source,sessionDir:path.join(f.root,'workflow'),steps:[{id:'early',type:'command',argv:[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`]},{id:'../escape',type:'verification',argv:['node','--version']}]}),/workflow.*id/i);
 assert.equal(await pathExists(marker),false);
});

test('full session query prints just one primary path without requiring a type',async t=>{
 const f=await fixture(t);const backup=await startBackupFromManifest(f);
 const proc=spawnSync(process.execPath,[CLI,'info',backup.id,'--view','full','--state-dir',f.stateRoot],{encoding:'utf8'});
 assert.equal(proc.status,0);assert.equal(proc.stdout.trim(),path.join(f.stateRoot,'sessions',backup.id,'session.json'));
});

test('restore source options are mutually exclusive rather than silently selecting one',async()=>{
 const proc=spawnSync(process.execPath,[CLI,'restore','--manifest','a.json','--handoff','b'],{encoding:'utf8'});
 assert.equal(proc.status,1);assert.match(proc.stderr,/exactly one.*--handoff.*--manifest/);
});

test('selected manifest bytes survive source edit while waiting for target',async t=>{
 const f=await fixture(t);const b=await startBackupFromManifest(f);
 const handoffPath=path.join(new URL(b.handoff.url).pathname,'workspace-recovery-manifest.json');
 const copy=path.join(f.root,'chosen.json');await fsp.copyFile(handoffPath,copy);
 const {startRestoreFromManifest,continueRestore}=await import('../src/core/restore.mjs');
 const {SessionStore}=await import('../src/core/session.mjs');
 const s=await startRestoreFromManifest({manifestPath:copy,stateRoot:f.stateRoot});
 assert.equal(s.state,'waiting_for_input');
 await fsp.writeFile(copy,'not JSON any more');
 const target=path.join(f.root,'new-target');
 const done=await continueRestore(new SessionStore(f.stateRoot),s,{target});
 assert.equal(done.state,'completed');
 assert.equal(await fsp.readFile(path.join(target,'data'),'utf8'),'version1');
});

test('workflow validation checks duplicates, conditions and timeouts without effects',async t=>{
 const f=await fixture(t);
 for(const steps of [
  [{id:'x',type:'command',argv:['node','--version'],when:'sometimes'}],
  [{id:'x',type:'command',argv:['node','--version'],timeoutMs:0}],
  [{id:'x',type:'command',argv:['node','--version']},{id:'x',type:'verification',argv:['node','--version']}],
 ])await assert.rejects(()=>executeWorkflow({workspace:f.source,sessionDir:path.join(f.root,'not-created'),steps}),/workflow/i);
 assert.equal(await pathExists(path.join(f.root,'not-created')),false);
});
