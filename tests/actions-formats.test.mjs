import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startBackupFromManifest, continueBackup } from '../src/core/backup.mjs';
import { executeRecoveryManifest } from '../src/core/restore.mjs';
import { buildStepReport } from '../src/core/reporting.mjs';
import { renderTemplate } from '../src/core/template.mjs';
import { SessionStore } from '../src/core/session.mjs';
const tmp=()=>fsp.mkdtemp(path.join(os.tmpdir(),'wr-action-'));
async function fixture(){const d=await tmp();const src=path.join(d,'src');await fsp.mkdir(src);await fsp.writeFile(path.join(src,'data'),'abc');return {d,src,stateRoot:path.join(d,'state'),manifestPath:path.join(d,'m.json')};}
function manifest(f, workflow) {return {schema:'workspace-recover/manifest/v3',name:'declarative',backup:{source:{path:f.src},provider:{type:'local-files',root:path.join(f.d,'objects')}},restore:{workflow},handoff:{provider:{type:'local-files',root:path.join(f.d,'objects')}}};}
const write=(p,v)=>fsp.writeFile(p,JSON.stringify(v));
test('031: named actions/reporters expand to a frozen explicit recovery workflow',async()=>{
 const f=await fixture();const m=manifest(f,['test','cleanup']);
 m.actions={test:{type:'verification',exec:[process.execPath,'-e',"console.log('TAP version 13\\n1..1\\nok 1 - saved')"],report:'tap-report'},cleanup:{type:'command',when:'always',exec:[process.execPath,'-e','process.exit(0)']}};
 m.reporters={'tap-report':{profile:'tap'}};await write(f.manifestPath,m);
 const s=await startBackupFromManifest(f);assert.equal(s.state,'completed');
 const r=JSON.parse(await fsp.readFile(path.join(f.stateRoot,'sessions',s.id,'workspace-recovery-manifest.json')));
 assert.deepEqual(r.restore.workflow.map(x=>x.id),['test','cleanup']);assert.ok(r.restore.workflow.every(x=>Array.isArray(x.argv)));
 assert.equal(r.restore.workflow[0].report.profile,'tap');assert.equal(r.actions,undefined);
 assert.match(s.info['step:test'].short,/tests=1/);
});
test('031: unknown action rejects before archiving or running an earlier step',async()=>{
 const f=await fixture();const m=manifest(f,['missing']);await write(f.manifestPath,m);
 await assert.rejects(startBackupFromManifest(f),/unknown action/);
});
test('031: action runtime placeholders remain late-bound in templates',async()=>{
 const t={schema:'workspace-recover/template/v3',inputs:{who:{type:'string'}},manifest:{schema:'workspace-recover/manifest/v3',actions:{a:{type:'verification',exec:['node','${workspace}/test.mjs','${who}']}},restore:{workflow:['a']}}};
 const r=await renderTemplate(t,{who:'operator'});assert.deepEqual(r.missing,[]);assert.equal(r.manifest.actions.a.exec[1],'${workspace}/test.mjs');
});
test('031: TAP reporter gives actual diagnostic totals, not generic trailing lines',async()=>{
 const d=await tmp();const result={status:'failed',exitCode:1,durationMs:10,stdout:'TAP version 13\n1..3\nok 1 - good\nnot ok 2 - bad\nok 3 - skipped # SKIP\n',stderr:''};
 const report=await buildStepReport({result,report:{profile:'tap'},reportDir:path.join(d,'r'),workspace:d});
 assert.match(report.short,/tests=3/);assert.match(report.short,/failures=1/);assert.match(report.short,/skipped=1/);assert.match(report.medium,/bad/);assert.ok((await fsp.stat(report.fullPath)).isFile());
});
test('031: JUnit testsuites wrapper aggregates child suites without losing totals',async()=>{
 const d=await tmp();await fsp.writeFile(path.join(d,'junit.xml'),'<testsuites><testsuite tests="2" failures="1" errors="0" skipped="0" time="1"><testcase><failure message="bad"/></testcase></testsuite><testsuite tests="3" failures="0" errors="0" skipped="1" time="2"/></testsuites>');
 const report=await buildStepReport({result:{status:'failed',exitCode:1},report:{profile:'junit',source:'junit.xml'},reportDir:path.join(d,'r'),workspace:d});assert.match(report.short,/tests=5/);assert.match(report.short,/failures=1/);assert.match(report.short,/skipped=1/);
});
test('031: transport version is checked before any provider access',async()=>{
 const d=await tmp();let calls=0;
 const r={schema:'workspace-recover/recovery-manifest/v3',transport:{schema:'workspace-recover/transport-manifest/v1',archive:{fileName:'a.tar.gz'},parts:[{index:0,fileName:'p'}]},restore:{workflow:[]}};
 await assert.rejects(executeRecoveryManifest({recovery:r,target:path.join(d,'out'),sessionDir:path.join(d,'s'),provider:{download:async()=>{calls++;}}}),/transport.*schema/);assert.equal(calls,0);
});
test('031: unsupported required capability rejects before provider access',async()=>{
 const d=await tmp();let calls=0;const r={schema:'workspace-recover/recovery-manifest/v3',requires:{formatVersion:3,features:['time-travel']},transport:{schema:'workspace-recover/transport-manifest/v3'},restore:{workflow:[]}};
 await assert.rejects(executeRecoveryManifest({recovery:r,target:path.join(d,'out'),sessionDir:path.join(d,'s'),provider:{download:async()=>{calls++;}}}),/capability|feature/i);assert.equal(calls,0);
});
test('031: unknown frozen plan version is rejected without rereading author manifest',async()=>{
 const d=await tmp();const store=new SessionStore(d);const s=await store.create('backup',{state:'waiting_for_auth',planFrozen:true});s.planPath=await store.write(s.id,'plan.json',{schema:'workspace-recover/plan/v1'});await store.save(s);
 await assert.rejects(continueBackup(store,s),/plan.*schema/);
});
test('031: full backup cleanup and restore of read-only directories run without root',async()=>{
 if(process.platform==='win32')return;
 const {spawnSync}=await import('node:child_process');const {fileURLToPath,pathToFileURL}=await import('node:url');
 const d=await tmp();await fsp.chmod(d,0o777);
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const src=path.join(d,'runtime-src');await fsp.cp(path.join(root,'src'),src,{recursive:true});
 const backupModule=pathToFileURL(path.join(src,'core/backup.mjs')).href;
 const restoreModule=pathToFileURL(path.join(src,'core/restore.mjs')).href;
 const script=`import fs from 'node:fs/promises';import {startBackupFromManifest} from ${JSON.stringify(backupModule)};import {startRestore} from ${JSON.stringify(restoreModule)};
 const base=${JSON.stringify(d)};const source=base+'/source';await fs.mkdir(source);await fs.mkdir(source+'/locked');await fs.writeFile(source+'/locked/data','exact');await fs.chmod(source+'/locked/data',0o444);await fs.chmod(source+'/locked',0o555);await fs.chmod(source,0o711);
 const m={schema:'workspace-recover/manifest/v3',backup:{source:{path:source},provider:{type:'local-files',root:base+'/objects'}},restore:{workflow:[]},handoff:{provider:{type:'local-files',root:base+'/objects'}}};const mp=base+'/manifest.json';await fs.writeFile(mp,JSON.stringify(m));const b=await startBackupFromManifest({manifestPath:mp,stateRoot:base+'/state'});if(b.state!=='completed')throw new Error(b.state);const r=await startRestore({handoff:b.handoff.url,target:base+'/restored',stateRoot:base+'/state'});if(r.state!=='completed')throw new Error(r.state);console.log(JSON.stringify({backup:b.state,restore:r.state}));`;
 const options={encoding:'utf8',cwd:d};if(process.getuid?.()===0){options.uid=65534;options.gid=65534;}
 const out=spawnSync(process.execPath,['--input-type=module','-e',script],options);assert.equal(out.status,0,out.stderr);
 assert.equal((await fsp.stat(path.join(d,'restored'))).mode&0o7777,0o711);
 assert.equal((await fsp.stat(path.join(d,'restored/locked'))).mode&0o7777,0o555);
 assert.equal((await fsp.stat(path.join(d,'restored/locked/data'))).mode&0o7777,0o444);
});
test('031: JSON-lines and artifact-list reporters preserve raw evidence before cleanup',async()=>{
 const d=await tmp();await fsp.writeFile(path.join(d,'events.jsonl'),' {"level":"info"}\n{"level":"error","error":"failed import"}\n');
 const r=await buildStepReport({result:{status:'passed'},report:{profile:'json-lines',source:'events.jsonl'},reportDir:path.join(d,'r1'),workspace:d});assert.match(r.short,/2 records/);assert.match(r.medium,/failed import/);
 const a=await buildStepReport({result:{status:'passed'},report:{profile:'artifact-list',sources:['events.jsonl']},reportDir:path.join(d,'r2'),workspace:d});await fsp.unlink(path.join(d,'events.jsonl'));assert.match(a.short,/1 artifacts/);assert.ok((await fsp.stat(r.fullPath)).isFile());const index=JSON.parse(await fsp.readFile(a.fullPath));assert.ok((await fsp.stat(index.artifacts[0].path)).isFile());
});
