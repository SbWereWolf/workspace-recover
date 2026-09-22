import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBackupFromManifest, continueBackup } from '../src/core/backup.mjs';
import { SessionStore } from '../src/core/session.mjs';
import { readJson, pathExists } from '../src/core/util.mjs';
import { executeRecoveryManifest } from '../src/core/restore.mjs';
import { initializeTemplate } from '../src/core/template.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/workspace-recover.mjs');
async function fixture(t) {
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wr-session-test-'));
 t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'); await fsp.mkdir(source); await fsp.writeFile(path.join(source,'data'),'test');
 const manifest={schema:'workspace-recover/manifest/v1',name:'session-test',backup:{source:{path:source,exclude:[]},provider:{type:'local-files',root:path.join(root,'objects')}},restore:{existingTarget:'reject',workflow:[]},handoff:{provider:{type:'local-files',root:path.join(root,'objects')},subject:'rebranding'}};
 const manifestPath=path.join(root,'manifest.json');const stateRoot=path.join(root,'state');
 await fsp.writeFile(manifestPath,JSON.stringify(manifest));
 return {root,source,manifest,manifestPath,stateRoot};
}

test('continue of a frozen direct manifest never requires a template or rereads the source',async t=>{
 const f=await fixture(t);
 f.manifest.backup.provider={type:'google-workspace',profile:'unconfigured-session-test',folderId:'test-folder'};
 f.manifest.handoff.provider=f.manifest.backup.provider;
 await fsp.writeFile(f.manifestPath,JSON.stringify(f.manifest));
 const s=await startBackupFromManifest(f);assert.equal(s.state,'waiting_for_auth');
 const before=await fsp.readFile(s.planPath);
 await fsp.writeFile(f.manifestPath,'modified source is no longer even JSON');
 const resumed=await continueBackup(new SessionStore(f.stateRoot),s);
 assert.equal(resumed.id,s.id);assert.equal(resumed.state,'waiting_for_auth');
 assert.deepEqual(await fsp.readFile(s.planPath),before);
});

test('operational CLI failures retain a terminal session and retrievable full report',async t=>{
 const f=await fixture(t); f.manifest.backup.source.path=path.join(f.root,'does-not-exist');
 await fsp.writeFile(f.manifestPath,JSON.stringify(f.manifest));
 const r=spawnSync(process.execPath,[CLI,'backup',f.manifestPath,'--state-dir',f.stateRoot],{encoding:'utf8'});
 assert.equal(r.status,1);const id=r.stdout.match(/Session: (\S+)/)?.[1];assert.ok(id,r.stdout+r.stderr);
 const s=await new SessionStore(f.stateRoot).load(id);assert.equal(s.state,'failed');
 assert.ok(s.info.error.fullPath);assert.equal((await readJson(s.info.error.fullPath)).sessionId,id);
 assert.match(r.stdout,/More: .*--state-dir/);
 const info=spawnSync(process.execPath,[CLI,'info',id,'--type','error','--view','full','--state-dir',f.stateRoot],{encoding:'utf8'});
 assert.equal(info.status,0);assert.equal(info.stdout.trim(),s.info.error.fullPath);
 assert.equal(info.stdout.trim().split('\n').length,1);
});

test('a failed verification reporter remains advisory and does not suppress manifest cleanup',async t=>{
 const f=await fixture(t);
 f.manifest.restore.workflow=[
  {id:'broken-report',type:'verification',argv:[process.execPath,'-e','process.exit(1)'],report:{profile:'junit',source:'not-produced.xml'}},
  {id:'cleanup',type:'command',argv:[process.execPath,'-e',"require('fs').writeFileSync('cleanup.ran','yes')"]}
 ];await fsp.writeFile(f.manifestPath,JSON.stringify(f.manifest));
 const s=await startBackupFromManifest(f);assert.equal(s.state,'completed_with_warnings');
 const receipt=await readJson(path.join(f.stateRoot,'sessions',s.id,'rehearsal-receipt.json'));
 t.after(()=>fsp.rm(receipt.cleanRoom,{recursive:true,force:true}));
 assert.equal(await fsp.readFile(path.join(receipt.cleanRoom,'workspace','cleanup.ran'),'utf8'),'yes');
 assert.ok(s.info['step:broken-report'].fullPath);
 const workflow=await readJson(s.info.workflow.fullPath);assert.match(workflow.items[0].reportError,/not-produced/);
});

test('failed clean-room extraction is preserved and recorded rather than deleted',async t=>{
 const f=await fixture(t);await fsp.symlink('/outside-source-is-not-allowed',path.join(f.source,'escape'));
 let failure;try {await startBackupFromManifest(f);}catch(e){failure=e;}
 assert.ok(failure);assert.ok(failure.sessionId);
 const s=await new SessionStore(f.stateRoot).load(failure.sessionId);assert.equal(s.state,'failed');
 const receipt=await readJson(path.join(f.stateRoot,'sessions',s.id,'rehearsal-receipt.json'));
 t.after(()=>fsp.rm(receipt.cleanRoom,{recursive:true,force:true}));
 assert.equal(receipt.restoreStatus,'failed');assert.equal(receipt.cleanRoomPreserved,true);
 assert.equal(await pathExists(path.join(receipt.cleanRoom,'workspace','data')),true);
});

test('unsafe transport filenames are rejected before any provider call',async t=>{
 const f=await fixture(t);let calls=0;
 const recovery={schema:'workspace-recover/recovery-manifest/v1',transport:{provider:{type:'local-files'},archive:{fileName:'backup.tar.gz'},parts:[{index:0,fileName:'../../escape',bytes:1,sha256:'0'.repeat(64),remote:{id:'unknown'}}]},restore:{existingTarget:'reject',workflow:[]}};
 await assert.rejects(()=>executeRecoveryManifest({recovery,target:path.join(f.root,'restored'),sessionDir:path.join(f.root,'run'),provider:{async download(){calls++;}}}),/unsafe.*file/i);
 assert.equal(calls,0);
});

test('session references cannot traverse outside the session directory',async t=>{
 const f=await fixture(t);const store=new SessionStore(f.stateRoot);
 assert.throws(()=>store.directory('../../elsewhere'),/invalid session/i);
});

test('template generator never overwrites an operator customized template',async t=>{
 const f=await fixture(t);const outputDirectory=path.join(f.root,'template');
 const options={presetDirectory:path.join(ROOT,'templates/local-project'),outputDirectory,name:'my-project'};
 const made=await initializeTemplate(options);await fsp.writeFile(made.templatePath,'operator-customized');
 await assert.rejects(()=>initializeTemplate(options),/already exists/);
 assert.equal(await fsp.readFile(made.templatePath,'utf8'),'operator-customized');
});
