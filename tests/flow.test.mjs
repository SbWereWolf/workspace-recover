import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runFlow,decideFlow,flowStatus,hostPlan,claimHost,replyFlow,recordPresented,validateFlow,shellQuote} from '../src/flow/engine.mjs';
import {defaultTemplate} from '../src/flow/cli.mjs';
import {initializeBridge,pendingRequests,submitResults} from '../src/core/bridge.mjs';
import {readJson,writeJsonAtomic,sha256File} from '../src/core/util.mjs';
const schema='workspace-recover/flow/v3';
async function fixture(t,steps,extra={}){
 const base=await fsp.mkdtemp(path.join(os.tmpdir(),'wr-flow-test-'));t.after(()=>fsp.rm(base,{recursive:true,force:true}));
 const workspace=path.join(base,'workspace'),directory=path.join(base,'session');await fsp.mkdir(workspace);
 const manifest={schema,steps,...extra};return {base,workspace,directory,manifest,run:(options={})=>runFlow({directory,workspace,manifest,...options})};
}
const write=(id,to,content='x',extra={})=>({id,op:'write',to,content,...extra});
const command=(id,code,extra={})=>({id,op:'command',argv:[process.execPath,'-e',code],...extra});
const text=p=>fsp.readFile(p,'utf8');
async function choose(f,result,choice,params={},extra={}){return decideFlow({directory:f.directory,requestId:result.decisionRequest.requestId,choice,params,...extra});}

test('041: stock template has no executable checks or project policy',()=>{
 assert.deepEqual(defaultTemplate.steps,[]);assert.equal(defaultTemplate.schema,schema);assert.match(defaultTemplate._comment,/Consider/);
 assert.doesNotMatch(JSON.stringify(defaultTemplate),/CJM|Stoneweave|applicationReady|expectedTests|junit|acceptance/);
});
test('041: empty flow needs no acceptance, folders, or questions',async t=>{const f=await fixture(t,[]);const r=await f.run();assert.equal(r.status,'COMPLETED');assert.equal(r.decisionRequest,null);assert.equal('applicationReady' in r,false);});
test('041: unnamed temporary workspace is generated without a question',async t=>{
 const f=await fixture(t,[]);const r=await runFlow({directory:f.directory,manifest:f.manifest});assert.equal(r.status,'COMPLETED');const s=await readJson(path.join(f.directory,'state.json'));assert.ok((await fsp.stat(s.workspace)).isDirectory());t.after(()=>fsp.rm(s.workspace,{recursive:true,force:true}));
});
test('041: absent declared workspace is created without a question',async t=>{const f=await fixture(t,[]);await fsp.rmdir(f.workspace);assert.equal((await f.run()).status,'COMPLETED');assert.ok((await fsp.stat(f.workspace)).isDirectory());});
test('041: future missing folder is not preflight-blocked before producer stage',async t=>{
 const f=await fixture(t,[{id:'stage',op:'mkdir',path:'not-yet-present'},write('file','not-yet-present/file'),{id:'pack',op:'archive',from:'not-yet-present',to:'bundle.tar.gz'}]);
 const r=await f.run();assert.equal(r.status,'COMPLETED');assert.equal(r.completedSteps,3);assert.equal(r.decisionRequest,null);assert.equal(r.results[2].output,r.results[2].path);assert.ok((await fsp.stat(r.results[2].output)).isFile());
});
test('041: tempdir has no mandatory path and is retained',async t=>{
 const f=await fixture(t,[{id:'stage',op:'tempdir',parent:'.',saveAs:'stage'},write('file','${variables.stage}/file')]);const r=await f.run();assert.equal(r.status,'COMPLETED');assert.equal(await text(path.join(r.results[0].path,'file')),'x');
});
test('041: declared missing temporary folder is created at that stage',async t=>{const f=await fixture(t,[{id:'stage',op:'tempdir',path:'late/staging'}]);assert.equal((await f.run()).status,'COMPLETED');assert.ok((await fsp.stat(path.join(f.workspace,'late/staging'))).isDirectory());});
test('041: current overwrite decision does not change future manifest policies',async t=>{
 const f=await fixture(t,[write('a','a','new-a'),write('b','b','new-b',{existingTarget:'overwrite'}),write('c','c')]);await fsp.writeFile(path.join(f.workspace,'a'),'old-a');await fsp.writeFile(path.join(f.workspace,'b'),'old-b');
 let r=await f.run();assert.equal(r.currentStep,'a');assert.equal(r.decisionRequest.scope,'current-step');assert.equal(r.completedSteps,0);
 r=await choose(f,r,'overwrite');assert.equal(r.status,'COMPLETED');assert.equal(r.decisionRequest,null);assert.equal(await text(path.join(f.workspace,'b')),'new-b');
 const s=await readJson(path.join(f.directory,'state.json'));assert.equal(s.decisions.length,1);assert.equal(s.manifest.steps[0].existingTarget,undefined);assert.equal(s.manifest.steps[1].existingTarget,'overwrite');
});
test('041: a later distinct ambiguity gets its own request, not inherited overwrite',async t=>{
 const f=await fixture(t,[write('a','a'),write('b','b')]);await fsp.writeFile(path.join(f.workspace,'a'),'old');await fsp.writeFile(path.join(f.workspace,'b'),'old');
 const first=await f.run(),second=await choose(f,first,'overwrite');assert.equal(second.currentStep,'b');assert.notEqual(first.decisionRequest.requestId,second.decisionRequest.requestId);assert.equal(await text(path.join(f.workspace,'b')),'old');
});
test('041: repeated run returns one stable pending request without reexecuting stages',async t=>{
 const f=await fixture(t,[write('a','a')]);await fsp.writeFile(path.join(f.workspace,'a'),'old');const a=await f.run(),b=await f.run();assert.equal(a.decisionRequest.requestId,b.decisionRequest.requestId);const s=await readJson(path.join(f.directory,'state.json'));assert.equal(s.attempts.a,1);
});
test('041: stale decision cannot affect another stage',async t=>{
 const f=await fixture(t,[write('a','a'),write('b','b')]);for(const name of ['a','b'])await fsp.writeFile(path.join(f.workspace,name),'old');
 const a=await f.run();await choose(f,a,'overwrite');await assert.rejects(choose(f,a,'overwrite'),/current stage/);assert.equal(await text(path.join(f.workspace,'b')),'old');
});
test('041: explicit skip affects this stage only',async t=>{
 const f=await fixture(t,[{id:'copy',op:'copy',from:'missing',to:'out'},write('next','next')]);let r=await f.run();r=await choose(f,r,'skip');assert.equal(r.status,'COMPLETED');assert.equal(r.results[0].status,'skipped');assert.equal(await text(path.join(f.workspace,'next')),'x');
});
test('041: explicit create-empty handles missing archive source',async t=>{
 const f=await fixture(t,[{id:'pack',op:'archive',from:'missing',to:'x.tar.gz'}]);let r=await f.run();assert.equal(r.decisionRequest.observation.code,'SOURCE_MISSING');r=await choose(f,r,'create-empty');assert.equal(r.status,'COMPLETED');
});
test('041: manifest create-empty avoids any question',async t=>{
 const f=await fixture(t,[{id:'pack',op:'archive',from:'missing',to:'x.tar.gz',missingSource:'create-empty'}]);assert.equal((await f.run()).status,'COMPLETED');
});
test('041: ordinary command failure is observed and following stage executes',async t=>{
 const f=await fixture(t,[command('fail','process.exit(7)'),write('next','next')]);const r=await f.run();assert.equal(r.status,'COMPLETED_WITH_OBSERVATIONS');assert.equal(r.results[0].exitCode,7);assert.equal(r.decisionRequest,null);assert.equal(await text(path.join(f.workspace,'next')),'x');
});
test('041: optional verification failure has no built-in business acceptance',async t=>{
 const f=await fixture(t,[{...command('check','process.exit(1)'),op:'verification'},write('next','next')]);const r=await f.run();assert.equal(r.completedSteps,2);assert.equal(r.decisionRequest,null);assert.ok(!('applicationReady' in r));
});
test('041: explicit onError ask is answered only for the failed command',async t=>{
 const f=await fixture(t,[command('fail','process.exit(1)',{onError:'ask'}),write('next','next')]);let r=await f.run();assert.equal(r.status,'WAITING_DECISION');r=await choose(f,r,'continue');assert.equal(r.status,'COMPLETED_WITH_OBSERVATIONS');assert.equal(r.results[0].status,'failed');assert.equal(r.completedSteps,2);
});
test('041: explicit onError stop honors the author rather than prompting',async t=>{
 const f=await fixture(t,[command('fail','process.exit(1)',{onError:'stop'}),write('next','next')]);const r=await f.run();assert.equal(r.status,'STOPPED');assert.equal(r.completedSteps,1);assert.equal(r.decisionRequest,null);
});
test('041: command retry waits without asking and executes only current stage',async t=>{
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);
 const f=await fixture(t,[command('retry',"const f=require('fs');if(!f.existsSync('once')){f.writeFileSync('once','x');process.exit(1)}",{retry:{maxAttempts:2,delayMs:60000}}),write('after','after')]);
 let r=await f.run();assert.equal(r.status,'WAITING_RETRY');assert.equal(r.decisionRequest,null);assert.match(r.next.ubuntu,/sleep/);assert.equal((await f.run()).status,'WAITING_RETRY');clock+=60000;r=await f.run();assert.equal(r.status,'COMPLETED');assert.equal(r.results[0].attempt,2);
});
test('041: completed run is idempotent and does not repeat a command',async t=>{
 const f=await fixture(t,[command('once',"require('fs').appendFileSync('count','1')")]);await f.run();await f.run();assert.equal(await text(path.join(f.workspace,'count')),'1');
});
test('041: limit pause resumes later stages without confirmation',async t=>{
 const f=await fixture(t,[write('a','a'),write('b','b')]);let r=await f.run({limit:1});assert.equal(r.status,'PAUSED');assert.equal(r.decisionRequest,null);r=await f.run();assert.equal(r.status,'COMPLETED');
});
test('041: replace-step changes only the current step',async t=>{
 const f=await fixture(t,[{id:'first',op:'copy',from:'missing',to:'unused'},write('next','next')]);let r=await f.run();r=await choose(f,r,'replace-step',{step:{op:'write',to:'instead',content:'replacement'}});assert.equal(r.status,'COMPLETED');assert.equal(await text(path.join(f.workspace,'instead')),'replacement');assert.equal(await text(path.join(f.workspace,'next')),'x');
});
test('041: source selection is stage scoped and does not erase declared hash observations',async t=>{
 const f=await fixture(t,[{id:'in',op:'input',names:['missing'],expected:{sha256:'0'.repeat(64)}},write('later','later')]);await fsp.writeFile(path.join(f.workspace,'chosen'),'content');let r=await f.run();r=await choose(f,r,'use-source',{path:path.join(f.workspace,'chosen')});assert.equal(r.status,'COMPLETED_WITH_OBSERVATIONS');assert.ok(r.observations.some(x=>x.code==='HASH_MISMATCH'));
});
test('041: identical input aliases are unambiguous',async t=>{
 const f=await fixture(t,[{id:'in',op:'input',names:['a','b']}]);for(const n of ['a','b'])await fsp.writeFile(path.join(f.workspace,n),'same');const r=await f.run();assert.equal(r.status,'COMPLETED');assert.equal(r.decisionRequest,null);
});
test('041: differing input bytes are a current-stage decision',async t=>{
 const f=await fixture(t,[write('before','before'),{id:'in',op:'input',names:['a','b']},write('after','after')]);for(const n of ['a','b'])await fsp.writeFile(path.join(f.workspace,n),n);const r=await f.run();assert.equal(r.completedSteps,1);assert.equal(r.currentStep,'in');assert.equal(r.decisionRequest.observation.code,'INPUT_AMBIGUOUS');
});
test('041: exact pin identifies one valid input despite another invalid alias',async t=>{
 const f=await fixture(t,[]);for(const n of ['a','b'])await fsp.writeFile(path.join(f.workspace,n),n);f.manifest.steps.push({id:'in',op:'input',names:['a','b'],expected:{sha256:await sha256File(path.join(f.workspace,'a'))}});const r=await f.run();assert.equal(r.completedSteps,1);assert.equal(r.decisionRequest,null);assert.ok(r.observations.length);
});
test('041: missing later input does not prevent earlier completed work',async t=>{
 const f=await fixture(t,[write('before','before'),{id:'in',op:'input',names:['absent']},write('after','after')]);const r=await f.run();assert.equal(r.completedSteps,1);assert.equal(await text(path.join(f.workspace,'before')),'x');
});
test('041: archive/extract roundtrip is generic and carries no test requirement',async t=>{
 const f=await fixture(t,[{id:'mkdir',op:'mkdir',path:'src'},write('data','src/data','bytes'),{id:'pack',op:'archive',from:'src',to:'data.tar.gz'},{id:'unpack',op:'extract',from:'${outputs.pack.path}',to:'restored'}]);const r=await f.run();assert.equal(r.status,'COMPLETED');assert.equal(await text(path.join(f.workspace,'restored/data')),'bytes');
});
test('041: copy merge is supported after a current-stage choice',async t=>{
 const f=await fixture(t,[{id:'c',op:'copy',from:'src',to:'dst'},write('after','after')]);await fsp.mkdir(path.join(f.workspace,'src'));await fsp.mkdir(path.join(f.workspace,'dst'));await fsp.writeFile(path.join(f.workspace,'src/a'),'new');await fsp.writeFile(path.join(f.workspace,'dst/b'),'keep');let r=await f.run();r=await choose(f,r,'merge');assert.equal(r.status,'COMPLETED');assert.equal(await text(path.join(f.workspace,'dst/a')),'new');assert.equal(await text(path.join(f.workspace,'dst/b')),'keep');
});
test('041: move overwrite preserves old destination and follows manifest',async t=>{
 const f=await fixture(t,[{id:'m',op:'move',from:'a',to:'b',existingTarget:'overwrite'}]);await fsp.writeFile(path.join(f.workspace,'a'),'new');await fsp.writeFile(path.join(f.workspace,'b'),'old');const r=await f.run();assert.equal(r.completedSteps,1);assert.equal(await text(path.join(f.workspace,'b')),'new');assert.ok((await fsp.readdir(f.workspace)).some(x=>x.startsWith('b.previous-')));
});
test('041: new-directory decision does not change subsequent target values',async t=>{
 const f=await fixture(t,[{id:'c',op:'copy',from:'src',to:'dst'},write('next','fixed')]);await fsp.mkdir(path.join(f.workspace,'src'));await fsp.mkdir(path.join(f.workspace,'dst'));await fsp.writeFile(path.join(f.workspace,'src/a'),'new');let r=await f.run();r=await choose(f,r,'new-directory');assert.equal(r.status,'COMPLETED');assert.match(r.results[0].path,/dst-/);assert.equal(await text(path.join(f.workspace,'fixed')),'x');
});
test('041: hash mismatch is a fact, not a global prohibition',async t=>{
 const f=await fixture(t,[write('a','a'),{id:'h',op:'hash',path:'a',expected:{sha256:'0'.repeat(64)}},write('b','b')]);const r=await f.run();assert.equal(r.status,'COMPLETED_WITH_OBSERVATIONS');assert.equal(r.completedSteps,3);assert.equal(r.results[1].checks,'mismatch');
});
test('041: no declared hash is valid and is reported as not-requested',async t=>{const f=await fixture(t,[write('a','a'),{id:'h',op:'hash',path:'a'}]);const r=await f.run();assert.equal(r.results[1].checks,'not-requested');});
test('041: interrupted mutation is not blindly repeated and caller can continue',async t=>{
 const f=await fixture(t,[write('a','a'),write('b','b')]);await f.run({limit:1});let state=await readJson(path.join(f.directory,'state.json'));state.status='RUNNING';state.inflight={stepId:'b',attempt:1};await writeJsonAtomic(path.join(f.directory,'state.json'),state);await fsp.writeFile(path.join(f.workspace,'b'),'already');let r=await f.run();assert.equal(r.decisionRequest.observation.code,'INTERRUPTED_OPERATION');r=await choose(f,r,'mark-completed',{result:{status:'passed',attestation:'machine'}});assert.equal(r.results[1].status,'reported-completed');assert.equal(r.results[1].attestation,'caller');assert.equal(await text(path.join(f.workspace,'b')),'already');
});
test('041: explicit retry of interrupted stage is allowed',async t=>{
 const f=await fixture(t,[write('a','a')]);await f.run({limit:1});let s=await readJson(path.join(f.directory,'state.json'));s.cursor=0;s.results=[];s.status='RUNNING';s.inflight={stepId:'a'};await writeJsonAtomic(path.join(f.directory,'state.json'),s);await fsp.unlink(path.join(f.workspace,'a'));let r=await f.run();r=await choose(f,r,'retry');assert.equal(r.status,'COMPLETED');
});
test('041: recommendations include shell-quoted Ubuntu commands',async t=>{
 const f=await fixture(t,[{id:'m',op:'copy',from:"file with ' quote",to:'dst'}]);const r=await f.run();assert.ok(r.decisionRequest.recommendations.every(x=>x.ubuntu));assert.ok(r.decisionRequest.options.every(x=>x.ubuntu));
 const quoted=shellQuote("a'; echo injection");const p=spawnSync('bash',['-c',`printf '%s' ${quoted}`],{encoding:'utf8'});assert.equal(p.stdout,"a'; echo injection");
});
test('041: malformed manifests do not execute actions',()=>{assert.throws(()=>validateFlow({schema,steps:[write('a','a'),write('a','b')]}),/IDs/);});
test('041: completed state stays fact-based after manifest file change',async t=>{
 const f=await fixture(t,[write('a','a')]);await f.run();f.manifest.steps.push(write('b','b'));const r=await f.run();assert.equal(r.completedSteps,1);assert.equal(r.decisionRequest,null);assert.ok(r.observations.some(x=>x.code==='SUPPLIED_MANIFEST_DIFFERS'));
});
test('041: missing executable is reported but does not block independent stages',async t=>{
 const f=await fixture(t,[{id:'missing',op:'command',argv:['no-such-command-wr-041']},write('next','next')]);const r=await f.run();assert.equal(r.results[0].status,'failed');assert.equal(r.completedSteps,2);
});
test('041: declared timeout returns a fact and next stage runs',async t=>{
 const f=await fixture(t,[command('slow','setTimeout(()=>{},10000)',{timeoutMs:30}),write('after','after')]);const r=await f.run();assert.equal(r.results[0].timedOut,true);assert.equal(r.completedSteps,2);
});

async function bridgeFixture(t,steps){const f=await fixture(t,steps);const bridge=path.join(f.base,'bridge');await initializeBridge(bridge,{schema:'workspace-recover/bridge-capabilities/v3',account:'operator@example.com',operations:['drive.upload','drive.download','drive.metadata','gmail.send','gmail.read']});f.manifest.bridge=bridge;f.bridge=bridge;return f;}
test('041: known remote input produces a host request, not a user question',async t=>{
 const f=await bridgeFixture(t,[{id:'input',op:'input',names:['absent'],remote:{id:'abc'}},write('after','after')]);const r=await f.run();assert.equal(r.status,'WAITING_HOST');assert.equal(r.decisionRequest,null);assert.equal(r.hostRequest.operation,'drive.download');const p=await hostPlan(f.directory);assert.equal(p.calls[0].arguments.fileId,'abc');
});
test('041: raw download reply resumes automatically and wrong object is not admitted',async t=>{
 const f=await bridgeFixture(t,[{id:'input',op:'input',names:['absent'],remote:{id:'abc'}},write('after','after')]);await f.run();const file=path.join(f.base,'download');await fsp.writeFile(file,'remote');
 await assert.rejects(replyFlow({directory:f.directory,result:{id:'other'},downloadPath:file}),/another/);
 await replyFlow({directory:f.directory,result:{id:'abc'},downloadPath:file});const r=await f.run();assert.equal(r.status,'COMPLETED');assert.equal(r.results[0].sha256,await sha256File(file));assert.equal(r.completedSteps,2);
});
test('041: host continuation reuses the same request identity',async t=>{
 const f=await bridgeFixture(t,[{id:'read',op:'host',operation:'drive.metadata',payload:{id:'abc'}}]);const a=await f.run(),b=await f.run();assert.equal(a.hostRequest.requestId,b.hostRequest.requestId);assert.equal((await pendingRequests(f.bridge)).requests.length,1);
});
test('041: upload call plan is complete; raw response normalization validates folder',async t=>{
 const f=await bridgeFixture(t,[write('data','data'),{id:'upload',op:'host',operation:'drive.upload',payload:{file:'data',folderId:'folder',name:'backup.txt'}}]);await f.run();const p=await hostPlan(f.directory);assert.equal(p.calls[0].tool,'Google_Drive.upload_file');assert.equal(p.calls[0].arguments.file_name,'backup.txt');
 await assert.rejects(replyFlow({directory:f.directory,result:{id:'remote',parent_id:'elsewhere'}}),/folder/);
 await replyFlow({directory:f.directory,result:{result:{id:'remote',parent_id:'folder',url:'https://example.invalid/object'}}});assert.equal((await f.run()).status,'COMPLETED');
});
test('041: mail call plan includes exact body file and attachment paths without human composition',async t=>{
 const f=await bridgeFixture(t,[write('info','info.json','{}'),{id:'mail',op:'host',operation:'gmail.send',payload:{to:['operator@example.com'],subject:'handoff',body:'Known body',attachments:['info.json']}}]);await f.run();const p=await hostPlan(f.directory);assert.equal(p.calls[0].arguments.to,'operator@example.com');assert.equal(await text(p.calls[0].arguments.body_file),'Known body');assert.equal(p.calls[0].arguments.attachment_files.length,1);await replyFlow({directory:f.directory,result:{result:{id:'abcdef'}}});assert.equal((await f.run()).status,'COMPLETED');
});
test('041: unknown external outcome is reconciled, not implicitly resent',async t=>{
 const f=await bridgeFixture(t,[{id:'send',op:'host',operation:'gmail.send',payload:{to:['operator@example.com'],subject:'x',body:'y'}}]);const first=await f.run(),q=first.hostRequest;
 await submitResults(f.bridge,{schema:'workspace-recover/connector-results/v3',results:[{requestId:q.requestId,requestHash:q.requestHash,sessionId:q.sessionId,status:'unknown',error:'timeout after send'}]});
 const r=await f.run();assert.equal(r.decisionRequest.observation.code,'REMOTE_OUTCOME_UNKNOWN');assert.equal((await pendingRequests(f.bridge)).requests.length,0);
});
test('041: explicit retry of unknown external operation creates a new bound attempt',async t=>{
 const f=await bridgeFixture(t,[{id:'send',op:'host',operation:'gmail.send',payload:{to:['operator@example.com'],subject:'x',body:'y'}}]);const a=await f.run(),q=a.hostRequest;
 await submitResults(f.bridge,{schema:'workspace-recover/connector-results/v3',results:[{requestId:q.requestId,requestHash:q.requestHash,sessionId:q.sessionId,status:'unknown',error:'timeout'}]});let r=await f.run();r=await choose(f,r,'retry');assert.equal(r.status,'WAITING_HOST');assert.notEqual(r.hostRequest.requestId,q.requestId);
});
test('041: status inspection does not create requests or run work',async t=>{const f=await fixture(t,[write('a','a'),write('b','b')]);await f.run({limit:1});const a=await flowStatus(f.directory),b=await flowStatus(f.directory);assert.deepEqual(a,b);assert.equal(a.completedSteps,1);});

test('041: claimed upload is reconciled instead of generating another upload call',async t=>{
 const f=await bridgeFixture(t,[write('a','a'),{id:'up',op:'host',operation:'drive.upload',payload:{file:'a',name:"name's.txt",folderId:'folder'}}]);await f.run();const first=await claimHost(f.directory);assert.equal(first.status,'CLAIMED');assert.equal(first.calls[0].tool,'Google_Drive.upload_file');const second=await claimHost(f.directory);assert.equal(second.status,'RECONCILE_HOST');assert.equal(second.calls[0].tool,'Google_Drive.search');assert.ok(!second.calls.some(x=>x.tool==='Google_Drive.upload_file'));assert.match(second.calls[0].arguments.special_filter_query_str,/name/);
});
test('041: claimed send generates a search plan, not another mail',async t=>{
 const f=await bridgeFixture(t,[{id:'mail',op:'host',operation:'gmail.send',payload:{to:'operator@example.com',subject:'fixed',body:'hello'}}]);await f.run();await claimHost(f.directory);const r=await hostPlan(f.directory);assert.equal(r.status,'RECONCILE_HOST');assert.equal(r.calls[0].tool,'Gmail.search_emails');assert.equal(r.decisionRequest,undefined);
});
test('041: claimed read can be retried without a human decision',async t=>{
 const f=await bridgeFixture(t,[{id:'read',op:'host',operation:'drive.metadata',payload:{id:'id'}}]);await f.run();await claimHost(f.directory);assert.equal((await hostPlan(f.directory)).status,'HOST_READ_RETRY');assert.equal((await f.run()).decisionRequest,null);
});
test('041: recorded remote result removes calls from the host plan',async t=>{
 const f=await bridgeFixture(t,[{id:'read',op:'host',operation:'drive.metadata',payload:{id:'id'}}]);await f.run();await claimHost(f.directory);await replyFlow({directory:f.directory,result:{id:'id'}});const r=await hostPlan(f.directory);assert.equal(r.status,'HOST_RESPONSE_READY');assert.deepEqual(r.calls,[]);
});
test('041: raw write error is unknown and cannot produce an automatic resend',async t=>{
 const f=await bridgeFixture(t,[{id:'mail',op:'host',operation:'gmail.send',payload:{to:'operator@example.com',subject:'fixed',body:'hello'}}]);await f.run();await replyFlow({directory:f.directory,result:{error:'transport timeout'}});assert.equal((await hostPlan(f.directory)).status,'RECONCILE_HOST');const r=await f.run();assert.equal(r.decisionRequest.observation.code,'REMOTE_OUTCOME_UNKNOWN');
});
test('041: reconciled remote outcome resumes without asking again',async t=>{
 const f=await bridgeFixture(t,[{id:'mail',op:'host',operation:'gmail.send',payload:{to:'operator@example.com',subject:'fixed',body:'hello'}},write('next','next')]);await f.run();await replyFlow({directory:f.directory,result:{error:'transport timeout'}});await f.run();await replyFlow({directory:f.directory,result:{id:'actual-id'}});const r=await f.run();assert.equal(r.completedSteps,2);assert.equal(r.decisionRequest,null);assert.ok(r.observations.some(x=>x.code==='REMOTE_OUTCOME_RECONCILED'));
});
test('041: raw read error follows declared retry without asking',async t=>{
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);
 const f=await bridgeFixture(t,[{id:'read',op:'host',operation:'drive.metadata',payload:{id:'id'},retry:{maxAttempts:2,delayMs:60000}}]);const a=await f.run();await replyFlow({directory:f.directory,result:{error:'network'}});let r=await f.run();assert.equal(r.status,'WAITING_RETRY');assert.equal(r.decisionRequest,null);clock+=60000;r=await f.run();assert.equal(r.status,'WAITING_HOST');assert.notEqual(r.hostRequest.requestId,a.hostRequest.requestId);
});
test('041: dotted step IDs and indexed outputs are usable in declarations',async t=>{
 const f=await fixture(t,[write('one.test','one'),{id:'copy',op:'copy',from:'${outputs.one.test.path}',to:'two'}]);assert.equal((await f.run()).status,'COMPLETED');assert.equal(await text(path.join(f.workspace,'two')),'x');
});
test('041: Gmail raw read maps real attachment paths and records actual bytes',async t=>{
 const f=await bridgeFixture(t,[{id:'read',op:'host',operation:'gmail.read',payload:{id:'mail-id',attachmentNames:['receipt.json']}}]);await f.run();const file=path.join(f.base,'receipt');await fsp.writeFile(file,'{}');await replyFlow({directory:f.directory,result:{id:'mail-id',body:'message',subject:'handoff',to:['operator@example.com'],attachments:[{filename:'receipt.json'}]},attachments:[{name:'receipt.json',path:file}]});const r=await f.run();assert.equal(r.results[0].localAttachments[0].sha256,await sha256File(file));assert.equal(await text(r.results[0].bodyFile),'message');
});
test('041: unknown Gmail attachment mapping is not treated as evidence',async t=>{
 const f=await bridgeFixture(t,[{id:'read',op:'host',operation:'gmail.read',payload:{id:'mail-id'}}]);await f.run();const file=path.join(f.base,'receipt');await fsp.writeFile(file,'{}');await assert.rejects(replyFlow({directory:f.directory,result:{id:'mail-id',body:'message',attachments:[]},attachments:[{name:'receipt.json',path:file}]}),/absent/);
});

test('041: outgoing upload snapshot stays bound after original input changes',async t=>{
 const f=await bridgeFixture(t,[write('a','a','original'),{id:'up',op:'host',operation:'drive.upload',payload:{file:'a',folderId:'folder'}}]);const a=await f.run();await fsp.writeFile(path.join(f.workspace,'a'),'changed');const b=await f.run();assert.equal(a.hostRequest.requestId,b.hostRequest.requestId);assert.equal(await text(b.hostRequest.payload.artifact.path),'original');
});
test('041: frozen outgoing corruption yields only a current-stage decision',async t=>{
 const f=await bridgeFixture(t,[write('a','a'),{id:'up',op:'host',operation:'drive.upload',payload:{file:'a',folderId:'folder'}}]);const a=await f.run();await fsp.writeFile(a.hostRequest.payload.artifact.path,'corrupt');assert.equal((await hostPlan(f.directory)).status,'LOCAL_INPUT_CHANGED');let r=await f.run();assert.equal(r.decisionRequest.observation.code,'PREPARED_HOST_BYTES_CHANGED');r=await choose(f,r,'retry');assert.equal(r.status,'WAITING_HOST');assert.notEqual(r.hostRequest.requestId,a.hostRequest.requestId);
});
test('041: outgoing mail body and attachments are snapshots, not live source references',async t=>{
 const f=await bridgeFixture(t,[write('body','body.txt','original'),write('attach','item.json','{}'),{id:'mail',op:'host',operation:'gmail.send',payload:{to:'operator@example.com',subject:'x',bodyFile:'body.txt',attachments:['item.json']}}]);const a=await f.run();await fsp.writeFile(path.join(f.workspace,'body.txt'),'changed');await fsp.writeFile(path.join(f.workspace,'item.json'),'changed');const b=await f.run();assert.equal(a.hostRequest.requestId,b.hostRequest.requestId);const p=await hostPlan(f.directory);assert.equal(await text(p.calls[0].arguments.body_file),'original');assert.equal(path.basename(p.calls[0].arguments.attachment_files[0]),'item.json');assert.equal(await text(p.calls[0].arguments.attachment_files[0]),'{}');
});
test('041: displayed question is durably marked and not requested again',async t=>{
 const f=await fixture(t,[{id:'x',op:'copy',from:'absent',to:'dst'}]);const a=await f.run();assert.equal(a.questionNeeded,true);await recordPresented({directory:f.directory,requestId:a.decisionRequest.requestId});const b=await f.run();assert.equal(b.questionNeeded,false);assert.equal(b.decisionRequest.requestId,a.decisionRequest.requestId);assert.match(b.instruction,/already been shown/);
});
test('041: marking another question as shown cannot affect the current stage',async t=>{
 const f=await fixture(t,[{id:'x',op:'copy',from:'absent',to:'dst'}]);await f.run();await assert.rejects(recordPresented({directory:f.directory,requestId:'wrong'}),/matching/);assert.equal((await flowStatus(f.directory)).questionNeeded,true);
});

test('041: copy detects destination under source through a symlink ancestor',async t=>{
 const f=await fixture(t,[{id:'copy',op:'copy',from:'source',to:'alias/child'},write('after','after')]);await fsp.mkdir(path.join(f.workspace,'source'));await fsp.writeFile(path.join(f.workspace,'source/data'),'x');await fsp.symlink(path.join(f.workspace,'source'),path.join(f.workspace,'alias'));const r=await f.run();assert.equal(r.results[0].status,'failed');assert.match(r.results[0].error,/overlap/);assert.equal(r.completedSteps,2);
});
test('041: upload preserves explicitly declared MIME type',async t=>{
 const f=await bridgeFixture(t,[write('a','a'),{id:'up',op:'host',operation:'drive.upload',payload:{file:'a',mimeType:'application/gzip'}}]);await f.run();assert.equal((await hostPlan(f.directory)).calls[0].arguments.mime_type,'application/gzip');
});

test('041: declared retries precede asking even when an operation throws',async t=>{
 const f=await fixture(t,[{id:'check',op:'hash',path:'not-yet-created',onError:'ask',retry:{maxAttempts:2,delayMs:0}},write('next','next')]);
 const a=await f.run();assert.equal(a.status,'WAITING_RETRY');assert.equal(a.decisionRequest,null);
 await fsp.writeFile(path.join(f.workspace,'not-yet-created'),'available now');const b=await f.run();assert.equal(b.status,'COMPLETED');assert.equal(b.completedSteps,2);assert.equal(b.decisionRequest,null);
});
test('041: retry exhaustion asks only at the failed current stage when declared',async t=>{
 const f=await fixture(t,[{id:'check',op:'hash',path:'absent',onError:'ask',retry:{maxAttempts:2,delayMs:0}},write('next','next')]);
 assert.equal((await f.run()).status,'WAITING_RETRY');const r=await f.run();assert.equal(r.status,'WAITING_DECISION');assert.equal(r.currentStep,'check');assert.equal(r.completedSteps,0);
 const end=await choose(f,r,'continue');assert.equal(end.results[0].status,'failed');assert.equal(end.completedSteps,2);assert.equal(end.decisionRequest,null);
});
