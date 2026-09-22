import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {initializeBridge,pendingRequests,submitResults,ConnectorBridge,canonical} from '../src/core/bridge.mjs';
import {schema} from '../src/core/formats.mjs';
import {startBackupFromManifest,continueBackup} from '../src/core/backup.mjs';
import {startRestore} from '../src/core/restore.mjs';
import {SessionStore} from '../src/core/session.mjs';
import {providerFromConfig} from '../src/core/providers.mjs';
import {sha256Text,readJson} from '../src/core/util.mjs';
const APP=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SID='wr_b_20260922123456_012345abcdef';
const caps={schema:schema('bridge-capabilities'),account:'operator@example.test',operations:['drive.upload','drive.download','drive.metadata','gmail.send','gmail.read']};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(){const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wr-connectors-'));const bridge=path.join(root,'bridge');await initializeBridge(bridge,caps);return {root,bridge};}
function response(r,result,status='completed'){return {requestId:r.requestId,requestHash:r.requestHash,sessionId:r.sessionId,status,...(status==='completed'?{result}:{error:result})};}
const batch=results=>({schema:schema('connector-results'),results});

async function hostFixture(f) {
 const files=new Map(),messages=new Map(),counts={},root=path.join(f.root,'remote');await fsp.mkdir(root);let next=0;
 async function processPending(){
  const requests=(await pendingRequests(f.bridge)).requests;const replies=[];
  for(const r of requests) {
   counts[r.operation]=(counts[r.operation]||0)+1;const p=r.payload;let result;
   if(r.operation==='drive.upload') {
    const id=`fixture_${++next}`,file=path.join(root,id);await fsp.copyFile(p.artifact.path,file);files.set(id,{path:file,parent:p.folderId});
    result={id,parent:p.folderId,bytes:(await fsp.stat(file)).size,url:`https://drive.google.com/file/d/${id}/view`};
   } else if(r.operation==='drive.download') {
    const saved=files.get(p.id);assert.ok(saved);const file=path.join(f.root,`fetched-${++next}`);await fsp.copyFile(saved.path,file);result={id:p.id,path:file,parent:saved.parent,bytes:(await fsp.stat(file)).size};
   } else if(r.operation==='drive.metadata')result={id:p.id,parent:files.get(p.id).parent};
   else if(r.operation==='gmail.send') {
    const id='1234567890abcdef';const a=[];
    for(const entry of p.attachments){const file=path.join(root,`attachment-${++next}`);await fsp.copyFile(entry.path,file);a.push({name:entry.name,path:file});}
    messages.set(id,{id,subject:p.subject,to:p.to,body:await fsp.readFile(p.bodyFile,'utf8'),attachments:a});result={id,url:`https://mail.google.com/mail/u/0/#all/${id}`};
   } else if(r.operation==='gmail.read') {result=messages.get(p.id);assert.ok(result);}
   else throw new Error(`unknown host action ${r.operation}`);
   replies.push(response(r,result));
  }
  if(replies.length)await submitResults(f.bridge,batch(replies));return requests.length;
 }
 async function drive(promise) {
  let done=false,value,error;Promise.resolve(promise).then(x=>{done=true;value=x;},e=>{done=true;error=e;});
  for(let i=0;!done&&i<2000;i++){await processPending();await sleep(10);}
  assert.ok(done,'connector host failed to finish');if(error)throw error;return value;
 }
 return {drive,processPending,counts,files,messages};
}
async function manifest(f,extra={}) {
 const source=path.join(f.root,'source');await fsp.mkdir(source);await fsp.writeFile(path.join(source,'data'),'actual bytes');
 const m={schema:schema('manifest'),name:'connector-fixture',backup:{source:{path:source},provider:{type:'google-workspace',folderId:'folder'},transport:{partSizeBytes:80}},restore:{workflow:[]},handoff:{provider:{type:'google-workspace'},to:caps.account,subject:'rebranding'},...extra};
 const file=path.join(f.root,'manifest.json');await fsp.writeFile(file,JSON.stringify(m));return file;
}
test('034: a running public CLI uses the host bridge without operator/OAuth prompts',async()=>{
 const f=await fixture(),h=await hostFixture(f),file=await manifest(f);
 const child=spawn(process.execPath,[`${APP}/bin/workspace-recover.mjs`,'backup',file,'--executor','connector','--bridge',f.bridge,'--state-dir',`${f.root}/state`],{cwd:os.tmpdir(),stdio:['ignore','pipe','pipe']});
 let text='';child.stdout.on('data',x=>text+=x);child.stderr.on('data',x=>text+=x);
 const exit=await h.drive(new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}));
 assert.equal(exit,0,text);assert.match(text,/State: completed/);assert.doesNotMatch(text,/Next:.*auth/);assert.equal(h.counts['gmail.send'],1);assert.ok(h.counts['drive.upload']>=3);
 const id=text.match(/Session: (wr_b_\w+)/)[1],s=await new SessionStore(`${f.root}/state`).load(id);
 assert.equal(s.executors.artifacts.mode,'connector');assert.equal(s.executors.handoff.account,caps.account);
 const recovery=await readJson(`${f.root}/state/sessions/${id}/workspace-recovery-manifest.json`);
 assert.equal(recovery.transport.provider.executor,undefined);assert.equal(recovery.transport.provider.bridge,undefined);
 const restored=await h.drive(startRestore({handoff:s.handoff.url,target:`${f.root}/restored`,stateRoot:`${f.root}/restore-state`,execution:{executor:'connector',bridge:f.bridge}}));
 assert.equal(restored.state,'completed');assert.equal(await fsp.readFile(`${f.root}/restored/data`,'utf8'),'actual bytes');
});
test('034: delegated batches resume without re-running rehearsal or mail send',async()=>{
 const f=await fixture(),h=await hostFixture(f),counter=`${f.root}/counter`;
 const file=await manifest(f,{restore:{workflow:[{id:'count',type:'verification',argv:[process.execPath,'-e',`require('fs').appendFileSync(${JSON.stringify(counter)},'run\\n')`]}]}});
 const state=`${f.root}/state`,store=new SessionStore(state);let s=await startBackupFromManifest({manifestPath:file,stateRoot:state,execution:{executor:'delegated',bridge:f.bridge}});
 const first=(await pendingRequests(f.bridge)).requests;assert.ok(first.length>=2,'all archive parts must be queued together');
 await fsp.writeFile(file,'AUTHOR FILE NOW CHANGED');
 for(let i=0;s.state.startsWith('waiting_')&&i<30;i++){await h.processPending();s=await continueBackup(store,await store.load(s.id));}
 assert.equal(s.state,'completed');assert.equal(await fsp.readFile(counter,'utf8'),'run\n');assert.equal(h.counts['gmail.send'],1);
 await continueBackup(store,s);assert.equal(h.counts['gmail.send'],1);
});
test('034: response binding, duplicate and conflicting results are checked atomically',async()=>{
 const f=await fixture(),bridge=new ConnectorBridge({root:f.bridge,sessionId:SID,mode:'delegated'});
 await assert.rejects(bridge.perform('drive.metadata',{id:'one'}),e=>e.code==='EXTERNAL_PENDING');
 const r=(await pendingRequests(f.bridge)).requests[0],good=response(r,{id:'one'});
 await assert.rejects(submitResults(f.bridge,batch([{...good,sessionId:SID.replace('012345','654321')}])) ,/match/);
 assert.equal((await pendingRequests(f.bridge)).requests.length,1);
 await submitResults(f.bridge,batch([good]));assert.equal((await submitResults(f.bridge,batch([good]))).duplicates,1);
 await assert.rejects(submitResults(f.bridge,batch([{...good,result:{id:'another'}}])),/conflict/);
 assert.deepEqual(await bridge.perform('drive.metadata',{id:'one'}),{id:'one'});
});
test('034: unknown send outcome is not resent and can be explicitly reconciled',async()=>{
 const f=await fixture(),b=new ConnectorBridge({root:f.bridge,sessionId:SID,mode:'delegated'});
 await assert.rejects(b.perform('gmail.send',{subject:'test'}),e=>e.code==='EXTERNAL_PENDING');
 const r=(await pendingRequests(f.bridge)).requests[0];await submitResults(f.bridge,batch([response(r,'Lost provider response','unknown')]));
 assert.equal((await pendingRequests(f.bridge)).requests.length,0);
 await assert.rejects(b.perform('gmail.send',{subject:'test'}),e=>e.code==='EXTERNAL_OUTCOME_UNKNOWN');
 const previous=await readJson(`${f.bridge}/responses/${r.requestId}.json`);
 await submitResults(f.bridge,batch([{...response(r,{id:'1234567890abcdef'}),resolvesSha256:sha256Text(canonical(previous))}]));
 assert.deepEqual(await b.perform('gmail.send',{subject:'test'}),{id:'1234567890abcdef'});
});
test('034: auto freezes the selected executor and does not switch after loss of bridge',async()=>{
 const f=await fixture(),c={type:'google-workspace',executor:'auto',bridge:f.bridge,sessionId:SID,sessionDir:`${f.root}/session`,requiredOperations:['drive.upload']};
 const p=providerFromConfig(c);await p.ready();assert.equal(p.executor,'connector');
 await fsp.rename(`${f.bridge}/capabilities.json`,`${f.bridge}/capabilities.hidden`);
 await assert.rejects(providerFromConfig(c).ready(),e=>e.code==='CAPABILITY_REQUIRED');
 assert.equal((await readJson(`${f.root}/session/executors/google.json`)).mode,'connector');
});
test('034: capabilities and account mismatches fail before creating outbound requests',async()=>{
 const f=await fixture();await assert.rejects(new ConnectorBridge({root:f.bridge,sessionId:SID,account:'other@example.test'}).ready(),/account/);
 await assert.rejects(new ConnectorBridge({root:f.bridge,sessionId:SID,requiredOperations:['missing']} ).ready(),e=>e.code==='CAPABILITY_REQUIRED');
 assert.equal((await pendingRequests(f.bridge)).requests.length,0);
});
test('034: v2 and malformed bridge responses are never accepted',async()=>{
 const f=await fixture();await assert.rejects(submitResults(f.bridge,{schema:'workspace-recover/connector-results/v2',results:[]}),/schema/);
 await assert.rejects(submitResults(f.bridge,batch([{requestId:'../escape'}])),/request ID/);
 await assert.rejects(initializeBridge(`${f.root}/bad`,{...caps,schema:'workspace-recover/bridge-capabilities/v2'}),/schema/);
});
test('034: a missing host capability produces a resumable session, not fake direct OAuth',async()=>{
 const f=await fixture(),file=await manifest(f);await fsp.rm(`${f.bridge}/capabilities.json`);
 const s=await startBackupFromManifest({manifestPath:file,stateRoot:`${f.root}/state`,execution:{executor:'connector',bridge:f.bridge}});
 assert.equal(s.state,'waiting_for_capability');assert.equal(s.planFrozen,true);assert.doesNotMatch(s.next.reason,/OAuth/);
});

test('034: a failed dispatcher records unknown outcome and is never automatically replayed',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wr-dispatch-')),bridge=root+'/bridge';
 await initializeBridge(bridge,{...caps,dispatchCommand:[process.execPath,'-e','process.exit(7)']});
 const b=new ConnectorBridge({root:bridge,sessionId:SID});
 await assert.rejects(b.perform('gmail.send',{subject:'audit'}),e=>e.code==='EXTERNAL_OUTCOME_UNKNOWN');
 assert.equal((await pendingRequests(bridge)).requests.length,0);
 await assert.rejects(b.perform('gmail.send',{subject:'audit'}),e=>e.code==='EXTERNAL_OUTCOME_UNKNOWN');
});
