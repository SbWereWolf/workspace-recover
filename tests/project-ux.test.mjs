import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'bin/workspace-recover.mjs');
const tmp=()=>fsp.mkdtemp(path.join(os.tmpdir(),'wr-project-'));
const json=(p,x)=>fsp.writeFile(p,JSON.stringify(x));
function cli(dir,...args){return spawnSync(process.execPath,[CLI,...args],{cwd:dir,encoding:'utf8',env:{...process.env,WORKSPACE_RECOVER_STATE_DIR:path.join(dir,'.test-state')}});}
async function setup(){const d=await tmp();const project=path.join(d,'project');await fsp.mkdir(project);await fsp.writeFile(path.join(project,'data'),'abc');const state=path.join(d,'state');const objects=path.join(d,'objects');return {d,project,state,objects};}
test('030: init creates portable versioned project and local values; backup needs no positional',async()=>{
 const {project,state,objects}=await setup();
 const init=cli(project,'init','local','--set',`backupRoot=${objects}`,'--state-dir',state,'--non-interactive');
 assert.equal(init.status,0,init.stderr);assert.match(init.stdout,/Session: wr_i_/);
 const config=JSON.parse(await fsp.readFile(path.join(project,'.workspace-recover/project.json')));
 assert.equal(config.schema,'workspace-recover/project/v3');assert.ok(!JSON.stringify(config).includes(project));
 assert.match(await fsp.readFile(path.join(project,'.workspace-recover/.gitignore'),'utf8'),/values.local.json/);
 const backup=cli(project,'backup','--state-dir',state);assert.equal(backup.status,0,backup.stderr);assert.match(backup.stdout,/State: completed/);
});
test('030: init missing inputs returns one batch and continue completes same initialization',async()=>{
 const {project,state}=await setup();const init=cli(project,'init','google-workspace','--state-dir',state,'--non-interactive');
 assert.equal(init.status,2,init.stderr); const id=init.stdout.match(/Session: (\S+)/)?.[1];assert.ok(id);
 const next=JSON.parse(cli(project,'next',id,'--json','--state-dir',state).stdout);
 assert.deepEqual(next.next.required.sort(),['driveFolderId','gmailTo']);
 await json(next.next.valuesFile,{schema:'workspace-recover/values/v3',values:{driveFolderId:'abc123',gmailTo:'operator@example.com'}});
 const done=cli(project,'continue',id,'--values',next.next.valuesFile,'--state-dir',state);assert.equal(done.status,0,done.stderr);assert.match(done.stdout,new RegExp(id));
 await fsp.access(path.join(project,'.workspace-recover/project.json'));
});
test('030: init never overwrites an existing authored configuration',async()=>{
 const {project,state,objects}=await setup();
 const args=['init','local','--set',`backupRoot=${objects}`,'--state-dir',state];assert.equal(cli(project,...args).status,0);
 const p=path.join(project,'.workspace-recover/template.json');const before=await fsp.readFile(p);
 assert.notEqual(cli(project,...args).status,0);assert.deepEqual(await fsp.readFile(p),before);
});
test('030: info/next/continue resolve current session in the project scope',async()=>{
 const {project,state,objects}=await setup();
 assert.equal(cli(project,'init','local','--set',`backupRoot=${objects}`,'--state-dir',state).status,0);
 const backup=cli(project,'backup','--state-dir',state);assert.equal(backup.status,0,backup.stderr);const id=backup.stdout.match(/Session: (\S+)/)[1];
 const info=cli(project,'info','--state-dir',state);assert.equal(info.status,0,info.stderr);assert.match(info.stdout,new RegExp(id));
 const full=cli(project,'info','--full','--state-dir',state);assert.equal(full.status,0,full.stderr);assert.equal(full.stdout.trim(),path.join(state,'sessions',id,'session.json'));
 assert.equal(cli(project,'continue','--state-dir',state).status,0);
});
test('030: nearest project is discovered from a nested directory',async()=>{
 const {project,state,objects}=await setup();
 assert.equal(cli(project,'init','local','--set',`backupRoot=${objects}`,'--state-dir',state).status,0);
 const sub=path.join(project,'nested');await fsp.mkdir(sub);
 const r=cli(sub,'backup','--state-dir',state);assert.equal(r.status,0,r.stderr);
 const id=r.stdout.match(/Session: (\S+)/)[1];assert.match(cli(project,'info','--state-dir',state).stdout,new RegExp(id));
});
test('030: no-argument info does not pick another project session',async()=>{
 const {d,project,state,objects}=await setup();
 assert.equal(cli(project,'init','local','--set',`backupRoot=${objects}`,'--state-dir',state).status,0);
 const other=path.join(d,'other');await fsp.mkdir(other);
 const r=cli(other,'info','--state-dir',state);assert.notEqual(r.status,0);assert.match(r.stderr,/current session/);
});
test('030: shipped presets and values describe the same versioned inputs',async()=>{
 for(const name of ['local','google-workspace']){const r=cli(ROOT,'template','describe',name,'--format','json');assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).schema,'workspace-recover/input-requirements/v3');}
});
test('030: relocated project binds source to the new project root',async()=>{
 const {d,project,state,objects}=await setup();
 const setupFile=path.join(d,'setup.json');await json(setupFile,{schema:'workspace-recover/values/v3',values:{projectName:null,sourcePath:null,backupRoot:objects}});
 assert.equal(cli(project,'init','local','--values',setupFile,'--state-dir',state).status,0);
 const moved=path.join(d,'moved');await fsp.rename(project,moved);
 const proc=cli(moved,'backup','--state-dir',state);assert.equal(proc.status,0,proc.stderr);
 const id=proc.stdout.match(/Session: (\S+)/)[1];const plan=JSON.parse(await fsp.readFile(path.join(state,'sessions',id,'plan.json')));
 assert.equal(plan.manifest.backup.source.path,moved);
});
test('030: noncurrent project schema fails rather than falling back to a parent',async()=>{
 const {project,state,objects}=await setup();
 assert.equal(cli(project,'init','local','--set',`backupRoot=${objects}`,'--state-dir',state).status,0);
 const p=path.join(project,'.workspace-recover/project.json');const old=JSON.parse(await fsp.readFile(p));old.schema='workspace-recover/project/v1';await json(p,old);
 const proc=cli(project,'backup','--state-dir',state);assert.notEqual(proc.status,0);assert.match(proc.stderr,/unsupported project schema/);
});
