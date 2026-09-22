import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const MODULE_DIR=path.dirname(fileURLToPath(import.meta.url));
import { spawn } from 'node:child_process';
import { createTarGz, extractTarGz } from '../core/archive.mjs';
import { ConnectorBridge, canonical, submitResults } from '../core/bridge.mjs';
import { nowIso, pathExists, readJson, sha256File, sha256Text, writeJsonAtomic } from '../core/util.mjs';

const SCHEMA = 'workspace-recover/flow/v3';
const STATE = 'workspace-recover/flow-state/v3';
const actions = new Set(['mkdir','tempdir','input','copy','move','archive','extract','command','verification','hash','write','host']);
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const clone = x => structuredClone(x);
const terminal = new Set(['COMPLETED','COMPLETED_WITH_OBSERVATIONS','STOPPED']);
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const hash = value => sha256Text(canonical(value));
const exists = p => pathExists(p);

export function validateFlow(flow) {
  if (!object(flow) || flow.schema !== SCHEMA || !Array.isArray(flow.steps)) throw new Error('Expected a flow manifest with a steps array.');
  const ids = new Set();
  for (const step of flow.steps) {
    if (!object(step) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(step.id || '') || ids.has(step.id)) throw new Error('Step IDs must be unique plain identifiers.');
    ids.add(step.id);
    if (!actions.has(step.op)) throw new Error(`Unsupported operation: ${step.op}`);
    // No filesystem probes here: a preceding stage may produce every later input.
    if (step.onError !== undefined && !['continue','ask','stop'].includes(step.onError)) throw new Error('Unknown onError behavior.');
    if (step.existingTarget !== undefined && !['merge','overwrite','new-directory','skip','ask'].includes(step.existingTarget)) throw new Error('Unknown existingTarget choice.');
    if (step.retry !== undefined && (!object(step.retry) || !Number.isInteger(step.retry.maxAttempts) || step.retry.maxAttempts < 1 || !(step.retry.delayMs >= 0))) throw new Error('retry needs maxAttempts >= 1 and delayMs >= 0.');
  }
  return flow;
}

function expand(value, context) {
  if (Array.isArray(value)) return value.map(x => expand(x, context));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,expand(v,context)]));
  if (typeof value !== 'string') return value;
  const lookup = key => {
    const parts=key.split('.'); let x=context;
    if(parts.some(p=>['__proto__','constructor','prototype'].includes(p)))throw new Error(`Unresolved value: ${key}`);
    while(parts.length){
      if(x===null||typeof x!=='object')throw new Error(`Unresolved value: ${key}`);
      let length=parts.length;while(length>0&&!Object.hasOwn(x,parts.slice(0,length).join('.')))length--;
      if(!length)throw new Error(`Unresolved value: ${key}`);
      x=x[parts.splice(0,length).join('.')];
    }
    return x;
  };
  const one=value.match(/^\$\{([A-Za-z0-9_.-]+)\}$/);
  if(one)return clone(lookup(one[1]));
  return value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g,(_,key)=>String(lookup(key)));
}
function context(state) { return { workspace:state.workspace, session:state.directory, variables:state.variables, outputs:state.outputs, env:process.env }; }
function local(state,value) { if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('A nonempty path is needed for this operation.');return path.resolve(state.workspace,value); }
async function physicalPath(p) {try{return await fsp.realpath(p);}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(p);return parent===p?p:path.join(await physicalPath(parent),path.basename(p));}}
async function fileRecord(file) { const s=await fsp.stat(file);return {path:path.resolve(file),bytes:s.size,sha256:await sha256File(file)}; }
function observation(code,message,extra={}) {return {code,message,...extra};}

class Choice extends Error {
  constructor(code,message,options,details={}) {super(message);Object.assign(this,{code,options,details});}
}
const commonChoices = ['retry','skip','replace-step','stop'];
function needChoice(code,message,options=[],details={}) {throw new Choice(code,message,[...new Set([...options,...commonChoices])],details);}

async function persist(state) {
  state.updatedAt=nowIso();
  await writeJsonAtomic(path.join(state.directory,'state.json'),state);
  await writeJsonAtomic(path.join(state.directory,'next-actions.json'),view(state));
}
export function view(state) {
  const base=['node',path.resolve(MODULE_DIR,'../../bin/workspace-recover.mjs'),'flow'];
  const run=[...base,'run','--session',state.directory];
  return { schema:'workspace-recover/flow-status/v3',sessionId:state.sessionId,status:state.status,
    currentStep:state.manifest.steps[state.cursor]?.id??null,completedSteps:state.cursor,totalSteps:state.manifest.steps.length,
    decisionRequest:state.pending??null,questionNeeded:!!state.pending&&!state.pending.presented,hostRequest:state.hostRequest??null,notBefore:state.notBefore??null,
    observations:state.observations,results:state.results,
    next:terminal.has(state.status)?null:{argv:run,ubuntu:state.notBefore?`sleep ${Math.max(0,Math.ceil((state.notBefore-Date.now())/1000))}; ${run.map(shellQuote).join(' ')}`:run.map(shellQuote).join(' ')},
    instruction:state.pending?(state.pending.presented?'The current question has already been shown. Await its answer without repeating it.':'Ask only about this current-stage request, then record it with flow presented. Resume the remaining manifest without confirmations.'):'No user question is needed. Execute the declared work or the host request.' };
}
async function saveChoice(state,step,error) {
  const signature={sessionId:state.sessionId,index:state.cursor,stepId:step.id,code:error.code,details:error.details};
  const requestId='decision_'+hash(signature);
  const prefix=['node',path.resolve(MODULE_DIR,'../../bin/workspace-recover.mjs'),'flow','decide','--session',state.directory,'--request',requestId];
  state.pending={schema:'workspace-recover/decision-request/v3',requestId,scope:'current-step',stepId:step.id,index:state.cursor,
    observation:{code:error.code,message:error.message,...error.details},
    recommendations:[{text:step.hint||'Inspect this stage, then choose how this stage should proceed.',ubuntu:`cat -- ${shellQuote(path.join(state.directory,'state.json'))}`},...(error.details.ubuntu?[{text:'Possible local resolution for this stage.',ubuntu:error.details.ubuntu}]:[])],
    options:error.options.map(choice=>({choice,argv:[...prefix,'--choice',choice],ubuntu:[...prefix,'--choice',choice].map(shellQuote).join(' '),
      ...(choice==='replace-step'?{paramsTemplate:{step:{id:step.id,op:'command',argv:['bash','-lc','YOUR_COMMAND']}}}:{}),
      ...(choice==='use-source'?{paramsTemplate:{path:'/absolute/source'},ubuntuTemplate:[...prefix,'--choice',choice,'--params',JSON.stringify({path:'/absolute/source'})].map(shellQuote).join(' ')}:{}),
      ...(choice==='new-directory'?{paramsTemplate:{path:'/absolute/new-directory'}}:{})})),
    note:'The answer applies to this stage only. It never becomes a global default.'};
  state.status='WAITING_DECISION';await persist(state);return view(state);
}

async function withLock(directory,fn) {
  await fsp.mkdir(directory,{recursive:true,mode:0o700});
  const lock=path.join(directory,'run.lock');let handle;
  try {handle=await fsp.open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,hostname:os.hostname(),createdAt:nowIso()}));}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    const owner=await readJson(lock).catch(()=>null);
    if(owner?.hostname===os.hostname()&&Number.isInteger(owner.pid)){
      let dead=false;try{process.kill(owner.pid,0);}catch(e){dead=e.code==='ESRCH';}
      if(dead){await fsp.rename(lock,`${lock}.stale-${crypto.randomUUID()}`);return withLock(directory,fn);}
    }
    return {status:'BUSY',decisionRequest:null,owner,instruction:'An active executor owns this session. Retry later; do not ask the user to confirm a known stage.'};
  }
  try{return await fn();}finally{await handle.close();await fsp.unlink(lock).catch(()=>{});}
}

async function initState({manifest,manifestPath,directory,workspace,bridge}) {
  const file=path.join(directory,'state.json');
  if(await exists(file)){
    const state=await readJson(file);if(state.schema!==STATE)throw new Error('Unsupported saved flow state.');
    if(state.directory!==directory)throw new Error('State was moved. Start a new flow session or explicitly repair its location.');
    if(manifest&&hash(manifest)!==state.manifestHash){
      const code='SUPPLIED_MANIFEST_DIFFERS';
      if(!state.observations.some(x=>x.code===code))state.observations.push(observation(code,'Continuing the saved manifest. Use a step-scoped decision to change the current stage, or another session for a new plan.'));
    }
    return state;
  }
  validateFlow(manifest);
  workspace=workspace||manifest.workspace;
  // A manifest can name a folder that does not exist; existence is not an input form requirement.
  if(!workspace)workspace=await fsp.mkdtemp(path.join(os.tmpdir(),'workspace-recover-flow-'));
  workspace=path.resolve(workspace);await fsp.mkdir(workspace,{recursive:true});
  return {schema:STATE,sessionId:`wr_r_${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}_${crypto.randomBytes(6).toString('hex')}`,
    directory,workspace,manifest:clone(manifest),manifestPath:manifestPath??null,manifestHash:hash(manifest),
    variables:clone(manifest.variables||{}),outputs:{},cursor:0,results:[],attempts:{},attemptHistory:[],decisions:[],overrides:{},observations:[],
    bridge:bridge||manifest.bridge||null,status:'RUNNING',pending:null,inflight:null,hostRequest:null,notBefore:null};
}

async function destination(state,step,p) {
  if(!await exists(p))return {path:p,mode:'new'};
  const policy=step.existingTarget;
  if(!policy||policy==='ask')needChoice('TARGET_EXISTS',`Destination exists: ${p}`,['merge','overwrite','new-directory'],{path:p});
  if(policy==='skip')return {path:p,mode:'skip'};
  if(policy==='new-directory')return {path:await fsp.mkdtemp(p+'-'),mode:'new-empty'};
  return {path:p,mode:policy};
}
async function source(state,step,p,isDirectory=false) {
  if(await exists(p))return p;
  if(step.missingSource==='skip')return null;
  if(step.missingSource==='create-empty'&&isDirectory){await fsp.mkdir(p,{recursive:true});return p;}
  needChoice('SOURCE_MISSING',`Input is not present at this stage: ${p}`,['use-source',...(isDirectory?['create-empty']:[])],{path:p,
    ubuntu:isDirectory?`mkdir -p -- ${shellQuote(p)}`:`ls -la -- ${shellQuote(path.dirname(p))}`});
}
async function checkHash(file,expected={}) {
  const value=await fileRecord(file),warnings=[];
  if(expected.sha256&&value.sha256!==expected.sha256)warnings.push(observation('HASH_MISMATCH','Observed bytes do not match the declared hash.',{expected:expected.sha256,actual:value.sha256,path:value.path,ubuntu:`sha256sum -- ${shellQuote(file)}`}));
  if(expected.bytes!==undefined&&value.bytes!==expected.bytes)warnings.push(observation('SIZE_MISMATCH','Observed size differs from the declaration.',{expected:expected.bytes,actual:value.bytes,path:value.path,ubuntu:`stat --format=%s -- ${shellQuote(file)}`}));
  return {...value,checks:warnings.length?'mismatch':expected.sha256||expected.bytes!==undefined?'matched':'not-requested',observations:warnings};
}
async function mergeCopy(src,dst,{replace=false,move=false}={}) {
  const stat=await fsp.lstat(src);
  if(stat.isDirectory()){
    if(await exists(dst)&&!(await fsp.lstat(dst)).isDirectory()){
      if(!replace)throw new Error(`Cannot merge directory over non-directory: ${dst}`);
      await fsp.rename(dst,`${dst}.previous-${crypto.randomUUID()}`);
    }
    await fsp.mkdir(dst,{recursive:true});
    for(const name of await fsp.readdir(src))await mergeCopy(path.join(src,name),path.join(dst,name),{replace,move});
    if(move)await fsp.rmdir(src);
  }else{
    await fsp.mkdir(path.dirname(dst),{recursive:true});
    // Preserve the old leaf instead of truncating an inode that may be hardlinked.
    if(await exists(dst))await fsp.rename(dst,`${dst}.previous-${crypto.randomUUID()}`);
    if(stat.isSymbolicLink())await fsp.symlink(await fsp.readlink(src),dst);
    else await fsp.copyFile(src,dst,fs.constants.COPYFILE_EXCL);
    if(move)await fsp.unlink(src);
  }
}
async function executeCommand(state,step) {
  if(!Array.isArray(step.argv)||!step.argv.length||step.argv.some(x=>typeof x!=='string'||x.includes('\0')))throw new Error('command needs argv strings.');
  const count=state.attempts[step.id],logDir=path.join(state.directory,'logs',`${state.cursor}-${step.id}-${count}`);
  await fsp.mkdir(logDir,{recursive:true});
  const out=await fsp.open(path.join(logDir,'stdout.log'),'w',0o600),err=await fsp.open(path.join(logDir,'stderr.log'),'w',0o600);
  let child,timer,killTimer,timedOut=false;
  const kill=sig=>{try{if(process.platform!=='win32')process.kill(-child.pid,sig);else child.kill(sig);}catch(e){if(e.code!=='ESRCH')throw e;}};
  const started=Date.now();
  try {
    child=spawn(step.argv[0],step.argv.slice(1),{cwd:local(state,step.cwd||'.'),env:{...process.env,...step.env},shell:false,detached:process.platform!=='win32',stdio:['ignore',out.fd,err.fd]});
    const result=await new Promise(resolve=>{
      child.once('error',e=>resolve({exitCode:null,error:e.message,errorCode:e.code}));
      child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));
      if(step.timeoutMs>0)timer=setTimeout(()=>{timedOut=true;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),250);},step.timeoutMs);
    });
    if(timedOut)kill('SIGKILL');
    return {...result,timedOut,status:result.exitCode===0&&!timedOut?'passed':'failed',durationMs:Date.now()-started,
      stdout:path.join(logDir,'stdout.log'),stderr:path.join(logDir,'stderr.log'),argv:step.argv};
  } finally {clearTimeout(timer);clearTimeout(killTimer);await out.close();await err.close();}
}

async function host(state,step) {
  if(!state.bridge)needChoice('HOST_BRIDGE_UNAVAILABLE','An authorized host bridge is not configured.',['replace-step'],{
    ubuntu:'node bin/workspace-recover.mjs bridge init --bridge /tmp/wr-bridge --capabilities /path/to/capabilities.json'});
  const bridge=new ConnectorBridge({root:state.bridge,sessionId:state.sessionId,mode:'delegated',requiredOperations:[step.operation],onPending:async request=>{state.hostRequest=request;await persist(state);}});
  let payload=state.preparedHost?.stepId===step.id&&state.preparedHost?.attempt===state.attempts[step.id]?clone(state.preparedHost.payload):null;
  if(!payload){
  payload=clone(step.payload||{});
  if(step.operation==='drive.upload'){
    const file=local(state,payload.file),dir=path.join(state.directory,'outgoing',step.id,String(state.attempts[step.id]));await fsp.mkdir(dir,{recursive:true});
    const snapshot=path.join(dir,'payload');await fsp.copyFile(file,snapshot,fs.constants.COPYFILE_EXCL);
    payload={artifact:{...await fileRecord(snapshot),name:payload.name||path.basename(file),mimeType:payload.mimeType||'application/octet-stream'},folderId:payload.folderId,sharing:'preserve'};
  }else if(step.operation==='gmail.send'){
    const body=payload.bodyFile?await fsp.readFile(local(state,payload.bodyFile),'utf8'):payload.body??'';
    const mailDir=path.join(state.directory,'outgoing',step.id,String(state.attempts[step.id]));await fsp.mkdir(mailDir,{recursive:true});
    const bodyFile=path.join(mailDir,'body.txt');await fsp.writeFile(bodyFile,body,{mode:0o600,flag:'wx'});
    const attachments=[];
    for(const a of payload.attachments||[]){
      const file=local(state,typeof a==='string'?a:a.path),name=typeof a==='string'?path.basename(file):a.name||path.basename(file);
      if(path.basename(name)!==name||!name||name==='.'||name==='..')throw new Error('Attachment name must be a basename.');
      const attachmentDir=path.join(mailDir,'attachments',String(attachments.length));await fsp.mkdir(attachmentDir,{recursive:true});
      const snapshot=path.join(attachmentDir,name);
      await fsp.copyFile(file,snapshot,fs.constants.COPYFILE_EXCL);
      attachments.push({...await fileRecord(snapshot),name:typeof a==='string'?path.basename(file):a.name||path.basename(file),mimeType:typeof a==='string'?'application/octet-stream':a.mimeType||'application/octet-stream'});
    }
    payload={to:Array.isArray(payload.to)?payload.to:[payload.to],subject:payload.subject,bodyFile,bodySha256:await sha256File(bodyFile),attachments,contentType:'text/plain'};
  }
  // Distinct stages/explicit retries get distinct requests; continuation gets the same request.
  payload={...payload,flowStepId:step.id,flowAttempt:state.attempts[step.id]};
  state.preparedHost={stepId:step.id,attempt:state.attempts[step.id],payload:clone(payload)};await persist(state);
  }
  for(const record of [payload.artifact,...(payload.attachments||[]),...(payload.bodyFile?[{path:payload.bodyFile,sha256:payload.bodySha256}]:[])].filter(Boolean)){
    if(!record.path)continue;
    if(!await exists(record.path)||await sha256File(record.path)!==record.sha256)needChoice('PREPARED_HOST_BYTES_CHANGED','The frozen outgoing bytes changed. Choose how this current stage should proceed.',['retry','skip','replace-step','stop'],{path:record.path,ubuntu:`sha256sum -- ${shellQuote(record.path)}`});
  }
  const identity={sessionId:state.sessionId,account:(await readJson(path.join(state.bridge,'capabilities.json'))).account,operation:step.operation,payload};
  const requestId='rq_'+hash(identity),claimFile=path.join(state.directory,'host-claims',requestId+'.json');
  const responseFile=path.join(state.bridge,'responses',requestId+'.json'),resolutionFile=path.join(state.bridge,'resolutions',requestId+'.json');
  if(await exists(claimFile)&&!await exists(responseFile)&&!await exists(resolutionFile)){
    const request=await readJson(path.join(state.bridge,'requests',requestId+'.json'));
    // Resume requests are for the host to reconcile, never a prompt or blind resend.
    const pending=new Error('Claimed host operation awaits actual response or reconciliation.');pending.code='EXTERNAL_PENDING';pending.request=request;throw pending;
  }
  const result=await bridge.perform(step.operation,payload);
  state.hostRequest=null;
  if(step.operation==='drive.download'&&result.path){
    const checks=await checkHash(result.path,step.expected||{});
    return {...result,...checks,status:'passed'};
  }
  return {status:'passed',...result,...(step.operation==='gmail.send'?{bodyFile:payload.bodyFile,bodySha256:payload.bodySha256,attachments:payload.attachments,subject:payload.subject,to:payload.to}:{})};
}

async function execute(state,step) {
  const op=step.op;
  if(op==='mkdir') {const p=local(state,step.path||step.to);await fsp.mkdir(p,{recursive:true});return {status:'passed',path:p};}
  if(op==='tempdir') {
    let p;if(step.path){p=local(state,step.path);await fsp.mkdir(p,{recursive:true});}
    else {const parent=step.parent?local(state,step.parent):os.tmpdir();await fsp.mkdir(parent,{recursive:true});p=await fsp.mkdtemp(path.join(parent,step.prefix||'wr-artifacts-'));}
    return {status:'passed',path:p,lifecycle:'retained-until-caller-cleanup'};
  }
  if(op==='input') {
    const roots=step.search||[state.workspace,path.dirname(state.manifestPath||state.directory)];
    const paths=step.path?[local(state,step.path)]:roots.flatMap(r=>(step.names||[]).map(n=>path.resolve(r,n)));
    const candidates=[];for(const p of [...new Set(paths)])if(await exists(p)&&(await fsp.stat(p)).isFile())candidates.push(await checkHash(p,step.expected||{}));
    const valid=candidates.filter(c=>c.checks!=='mismatch'),distinct=new Set(valid.map(c=>c.sha256));
    if(distinct.size===1){const selected=valid[0];if(candidates.length>valid.length)selected.observations.push(observation('OTHER_CANDIDATES_DIFFER','The declaration identifies one byte sequence; other candidates were not selected.'));return {status:'passed',...selected};}
    if(distinct.size>1)needChoice('INPUT_AMBIGUOUS','Different input bytes are available and no declaration selects one.',['use-source'],{candidates});
    if(candidates.length===1&&step.onMismatch==='continue')return {status:'passed',...candidates[0]};
    if(!candidates.length&&step.remote)return host(state,{...step,operation:'drive.download',payload:step.remote});
    if(!candidates.length&&step.missingSource==='skip')return {status:'skipped',reason:'manifest'};
    needChoice(candidates.length?'INPUT_MISMATCH':'INPUT_MISSING','Choose the input for this stage only.',['use-source',...(candidates.length===1?['use-observed']:[])],{candidates,search:paths});
  }
  if(op==='hash')return {status:'passed',...await checkHash(local(state,step.path),step.expected||{})};
  if(op==='command'||op==='verification')return executeCommand(state,step);
  if(op==='host')return host(state,step);
  if(op==='write') {
    const d=await destination(state,step,local(state,step.path||step.to));if(d.mode==='skip')return {status:'skipped',path:d.path};
    if(d.mode==='new-empty')throw new Error('new-directory is not a destination for a file write; supply another file path.');
    await fsp.mkdir(path.dirname(d.path),{recursive:true});
    const tmp=d.path+'.writing-'+crypto.randomUUID();await fsp.writeFile(tmp,typeof step.content==='string'?step.content:JSON.stringify(step.content,null,2)+'\n',{flag:'wx',mode:step.mode??0o600});
    await fsp.rename(tmp,d.path);return {status:'passed',...await fileRecord(d.path)};
  }
  if(op==='copy'||op==='move') {
    const src=await source(state,step,local(state,step.from),step.sourceKind==='directory');if(!src)return {status:'skipped',reason:'manifest'};
    const d=await destination(state,step,local(state,step.to));if(d.mode==='skip')return {status:'skipped',path:d.path};
    const srcReal=await physicalPath(src),dstReal=await physicalPath(d.path);
    if(srcReal===dstReal||dstReal.startsWith(srcReal+path.sep))throw new Error('Source and destination overlap. Use a distinct destination.');
    await fsp.mkdir(path.dirname(d.path),{recursive:true});
    if(d.mode==='overwrite'&&await exists(d.path)){const preserved=d.path+'.previous-'+crypto.randomUUID();await fsp.rename(d.path,preserved);state.observations.push(observation('PREVIOUS_TARGET_PRESERVED','Replaced destination was retained.',{path:preserved}));}
    if(op==='move'&&d.mode!=='merge'&&d.mode!=='new-empty'){
      try{await fsp.rename(src,d.path);}catch(e){if(e.code!=='EXDEV')throw e;await mergeCopy(src,d.path,{replace:true,move:true});}
    }else await mergeCopy(src,d.path,{replace:d.mode==='overwrite',move:op==='move'});
    return {status:'passed',path:d.path,source:src};
  }
  if(op==='archive') {
    const src=await source(state,step,local(state,step.from),true);if(!src)return {status:'skipped',reason:'manifest'};
    const output=local(state,step.to);if(output===src||output.startsWith(src+path.sep))throw new Error('Archive output is inside its own source. Choose an external output path.');
    const d=await destination(state,step,output);if(d.mode==='skip')return {status:'skipped',path:d.path};
    if(d.mode==='new-empty')throw new Error('Archive output needs a file path, not a directory.');
    await fsp.mkdir(path.dirname(d.path),{recursive:true});
    const temporary=d.path+'.packing-'+crypto.randomUUID();
    const result=await createTarGz({source:src,output:temporary,includes:step.include||['**'],excludes:step.exclude||[]});
    await fsp.rename(temporary,d.path);
    return {status:'passed',...result,output:d.path,path:d.path};
  }
  if(op==='extract') {
    const src=await source(state,step,local(state,step.from));if(!src)return {status:'skipped',reason:'manifest'};
    const d=await destination(state,step,local(state,step.to));if(d.mode==='skip')return {status:'skipped',path:d.path};
    if(d.mode==='overwrite'&&await exists(d.path)){const preserved=d.path+'.previous-'+crypto.randomUUID();await fsp.rename(d.path,preserved);state.observations.push(observation('PREVIOUS_TARGET_PRESERVED','Replaced destination was retained.',{path:preserved}));}
    await extractTarGz({archive:src,destination:d.path,rejectExisting:!['merge','new-empty'].includes(d.mode)});
    return {status:'passed',path:d.path,archive:src};
  }
  throw new Error(`Unsupported action: ${op}`);
}

function effectiveStep(state) {const original=state.manifest.steps[state.cursor];return {...original,...state.overrides[original.id],id:original.id};}
async function complete(state,step,result) {
  const entry={id:step.id,op:step.op,attempt:state.attempts[step.id],...result,stepId:step.id,finishedAt:nowIso()};
  state.results.push(entry);state.outputs[step.id]=clone(entry);if(step.saveAs)state.variables[step.saveAs]=entry.path??clone(entry);
  state.observations.push(...(result.observations||[]));
  if(result.status==='failed')state.observations.push(observation('STEP_FAILED','The operation failed; this fact does not prohibit following stages.',{stepId:step.id,error:result.error,exitCode:result.exitCode,ubuntu:result.stderr?`cat -- ${shellQuote(result.stderr)}`:undefined}));
  state.cursor++;state.inflight=null;state.pending=null;state.hostRequest=null;state.notBefore=null;state.pendingResult=null;
  delete state.overrides[step.id];state.preparedHost=null;
}

async function drive(state,limit) {
  if(terminal.has(state.status)||state.pending)return view(state);
  if(state.notBefore&&Date.now()<state.notBefore)return view(state);
  if(state.inflight&&!['WAITING_HOST','WAITING_RETRY'].includes(state.status)){
    return saveChoice(state,effectiveStep(state),new Choice('INTERRUPTED_OPERATION','The prior executor stopped inside this stage; its effects may already exist.',['mark-completed','retry','skip','replace-step','stop'],{inflight:state.inflight}));
  }
  let done=0;
  while(state.cursor<state.manifest.steps.length&&done<limit){
    let step=effectiveStep(state),resumingHost=state.status==='WAITING_HOST';
    if(!resumingHost)state.attempts[step.id]=(state.attempts[step.id]||0)+1;
    state.status='RUNNING';state.notBefore=null;state.inflight={stepId:step.id,attempt:state.attempts[step.id],startedAt:nowIso()};await persist(state);
    try {
      step=expand(step,context(state));
      const result=await execute(state,step);
      if(result.status==='failed'){
        const retry=step.retry;
        if(retry&&state.attempts[step.id]<retry.maxAttempts){
          state.attemptHistory.push({id:step.id,attempt:state.attempts[step.id],...result});state.status='WAITING_RETRY';state.inflight=null;state.preparedHost=null;state.notBefore=Date.now()+retry.delayMs;await persist(state);return view(state);
        }
        if(step.onError==='ask'){state.pendingResult=result;return saveChoice(state,step,new Choice('COMMAND_FAILED','The manifest delegates this failed stage to the caller.',['continue',...commonChoices],{exitCode:result.exitCode,stderr:result.stderr}));}
      }
      await complete(state,step,result);done++;
      if(result.status==='failed'&&step.onError==='stop'){state.status='STOPPED';await persist(state);return view(state);}
    } catch(error) {
      if(error instanceof Choice){state.inflight=null;return saveChoice(state,step,error);}
      if(error.code==='EXTERNAL_PENDING'){
        state.status='WAITING_HOST';state.hostRequest=error.request;await persist(state);return view(state);
      }
      if(error.code==='EXTERNAL_OUTCOME_UNKNOWN')return saveChoice(state,step,new Choice('REMOTE_OUTCOME_UNKNOWN',error.message,['mark-completed','retry','skip','replace-step','stop'],{hostRequest:error.request}));
      const result={status:'failed',error:error.message,errorCode:error.code??null};
      const retry=step.retry;
      if(retry&&state.attempts[step.id]<retry.maxAttempts){state.attemptHistory.push({id:step.id,attempt:state.attempts[step.id],...result});state.status='WAITING_RETRY';state.inflight=null;state.preparedHost=null;state.notBefore=Date.now()+retry.delayMs;await persist(state);return view(state);}
      if(step.onError==='ask'){state.pendingResult=result;state.inflight=null;return saveChoice(state,step,new Choice('OPERATION_FAILED',error.message,['continue',...commonChoices]));}
      await complete(state,step,result);done++;
      if(step.onError==='stop'){state.status='STOPPED';await persist(state);return view(state);}
    }
    await persist(state);
  }
  state.status=state.cursor===state.manifest.steps.length?(state.observations.length?'COMPLETED_WITH_OBSERVATIONS':'COMPLETED'):'PAUSED';
  await persist(state);return view(state);
}

export async function runFlow({manifest,manifestPath=null,directory,workspace=null,bridge=null,limit=Infinity}) {
  directory=path.resolve(directory);if(!(limit===Infinity||(Number.isInteger(limit)&&limit>0)))throw new Error('limit must be a positive integer.');
  return withLock(directory,async()=>{const state=await initState({manifest,manifestPath,directory,workspace,bridge});await persist(state);return drive(state,limit);});
}
export async function flowStatus(directory) {return view(await readJson(path.join(path.resolve(directory),'state.json')));}
export async function decideFlow({directory,requestId,choice,params={},limit=Infinity}) {
  directory=path.resolve(directory);
  return withLock(directory,async()=>{
    const state=await readJson(path.join(directory,'state.json')),request=state.pending;
    if(!request||request.requestId!==requestId||request.index!==state.cursor||request.stepId!==state.manifest.steps[state.cursor]?.id)throw new Error('Decision does not match the current stage/request. Nothing was executed.');
    if(!request.options.some(o=>o.choice===choice))throw new Error('Unknown choice for this request.');
    const step=effectiveStep(state),changes={...state.overrides[step.id]};
    state.decisions.push({requestId,stepId:step.id,index:state.cursor,choice,params:clone(params),recordedAt:nowIso(),scope:'current-step'});
    if(choice==='stop'){state.status='STOPPED';state.pending=null;state.inflight=null;await persist(state);return view(state);}
    if(['skip','mark-completed','continue'].includes(choice)){
      await complete(state,step,choice==='continue'?(state.pendingResult||{status:'failed',error:'Caller continued after interrupted operation'}):{...params.result,status:choice==='skip'?'skipped':'reported-completed',attestation:'caller'});
    }else{
      if(['merge','overwrite'].includes(choice))changes.existingTarget=choice;
      if(choice==='new-directory'){
        if(params.path){const key=step.op==='write'?'path':'to';changes[key]=params.path;changes.existingTarget='ask';}
        else changes.existingTarget='new-directory';
      }
      if(choice==='use-source'){
        if(typeof params.path!=='string'||!params.path)throw new Error('use-source needs params.path.');
        changes[step.op==='input'?'path':'from']=params.path;
        if(step.op==='input')changes.onMismatch='continue';
      }
      if(choice==='use-observed')changes.onMismatch='continue';
      if(choice==='create-empty')changes.missingSource='create-empty';
      if(choice==='replace-step'){
        if(!object(params.step))throw new Error('replace-step needs params.step.');
        const replacement={...step,...params.step,id:step.id};validateFlow({schema:SCHEMA,steps:[replacement]});Object.assign(changes,replacement);
      }
      state.overrides[step.id]=changes;state.pending=null;state.inflight=null;state.pendingResult=null;state.preparedHost=null;
    }
    state.status='RUNNING';await persist(state);return drive(state,limit);
  });
}

export async function hostPlan(directory,{ignoreClaim=false}={}) {
  const state=await readJson(path.join(path.resolve(directory),'state.json')),r=state.hostRequest;
  if(!r)return {status:'NO_HOST_ACTION',calls:[],decisionRequest:null};
  const response=path.join(state.bridge,'responses',r.requestId+'.json'),resolution=path.join(state.bridge,'resolutions',r.requestId+'.json');
  let unknownResponse=false;
  if(await exists(response)||await exists(resolution)){
    const actual=await readJson(await exists(resolution)?resolution:response);
    unknownResponse=actual.status==='unknown';
    if(actual.status!=='unknown')return {status:'HOST_RESPONSE_READY',calls:[],decisionRequest:null,instruction:'Resume flow; do not invoke the connector again.'};
  }
  const claimed=unknownResponse||await exists(path.join(state.directory,'host-claims',r.requestId+'.json'));
  const p=r.payload;let calls=[];
  for(const record of [p.artifact,...(p.attachments||[]),...(p.bodyFile?[{path:p.bodyFile,sha256:p.bodySha256}]:[])].filter(Boolean)){
    if(!record.path)continue;
    if(!await exists(record.path)||await sha256File(record.path)!==record.sha256)return {status:'LOCAL_INPUT_CHANGED',calls:[],requestId:r.requestId,instruction:'Resume flow for a current-stage decision; the prepared bytes no longer match.',ubuntu:`sha256sum -- ${shellQuote(record.path)}`};
  }
  if(claimed&&!ignoreClaim){
    const escape=x=>String(x).replaceAll('\\','\\\\').replaceAll("'","\\'");
    if(r.operation==='drive.upload')calls=[{tool:'Google_Drive.search',arguments:{query:'',special_filter_query_str:`trashed = false and name = '${escape(p.artifact.name)}'`+(p.folderId?` and '${escape(p.folderId)}' in parents`:''),best_effort_fetch:false}}];
    if(r.operation==='gmail.send')calls=[{tool:'Gmail.search_emails',arguments:{query:`in:sent to:(${p.to.join(' ')}) subject:${JSON.stringify(p.subject)}`,max_results:10}}];
    if(!['drive.upload','gmail.send'].includes(r.operation)){
      return {...await hostPlan(directory,{ignoreClaim:true}),status:'HOST_READ_RETRY',instruction:'Read-only call may be repeated; no operator question is needed.'};
    }
    return {schema:'workspace-recover/host-action/v3',status:'RECONCILE_HOST',requestId:r.requestId,operation:r.operation,calls,
      expected:p,note:'Compare actual candidates with prepared content. Submit the observed object/message ID with flow reply. Do not resend an unknown write. If no candidate can resolve the outcome, submit an unknown result and let the current-stage caller decide.'};
  }
  if(r.operation==='drive.upload')calls=[{tool:'Google_Drive.upload_file',arguments:{file_uri:p.artifact.path,file_name:p.artifact.name,parent_folder_id:p.folderId??null,mime_type:p.artifact.mimeType||'application/octet-stream'}}];
  if(r.operation==='drive.download')calls=[{tool:'Google_Drive.get_file_metadata',arguments:{fileId:p.id}},{tool:'Google_Drive.fetch',arguments:{url:'${metadata.url}',download_raw_file:true,include_base64:false}}];
  if(r.operation==='drive.metadata')calls=[{tool:'Google_Drive.get_file_metadata',arguments:{fileId:p.id}}];
  if(r.operation==='gmail.send')calls=[{tool:'Gmail.send_email',arguments:{to:p.to.join(','),subject:p.subject,body_file:p.bodyFile,content_type:'text/plain',attachment_files:p.attachments.map(a=>a.path)}}];
  if(r.operation==='gmail.read')calls=[{tool:'Gmail.read_email',arguments:{message_id:p.id}},...(p.attachmentNames||[]).map(name=>({tool:'Gmail.read_attachment',arguments:{message_id:p.id,filename:name},note:'Use the complete attachment_id from the parent read when present; otherwise exact filename.'}))];
  return {schema:'workspace-recover/host-action/v3',status:'HOST_ACTION',requestId:r.requestId,operation:r.operation,calls,
    reply:{command:`node bin/workspace-recover.mjs flow reply --session ${shellQuote(state.directory)} --result /path/to/raw-connector-result.json`,downloadPathOption:'--path /exact/materialized/path'},
    note:'The host invokes authorized connectors and returns actual outputs. It does not select files, invent metadata, change recipients, or ask the user again.'};
}
export async function claimHost(directory) {
  directory=path.resolve(directory);
  return withLock(directory,async()=>{
    const plan=await hostPlan(directory);if(plan.status!=='HOST_ACTION')return plan;
    const state=await readJson(path.join(directory,'state.json')),request=state.hostRequest;
    const claim=path.join(directory,'host-claims',request.requestId+'.json');await fsp.mkdir(path.dirname(claim),{recursive:true});
    await fsp.writeFile(claim,JSON.stringify({schema:'workspace-recover/host-claim/v3',requestId:request.requestId,requestHash:request.requestHash,sessionId:request.sessionId,at:nowIso()}),{flag:'wx',mode:0o600});
    return {...plan,status:'CLAIMED',instruction:'Execute these calls once and submit actual outputs. After an interruption use host-plan for reconciliation.'};
  });
}

export async function replyFlow(options) {
  const directory=path.resolve(options.directory);
  return withLock(directory,()=>replyFlowUnlocked({...options,directory}));
}
async function replyFlowUnlocked({directory,result,downloadPath=null,attachments=[]}) {
  const state=await readJson(path.join(path.resolve(directory),'state.json')),request=state.hostRequest;
  if(!request)throw new Error('There is no pending host request.');
  let raw=result;while(object(raw?.result)&&!raw.id)raw=raw.result;
  if(raw.error){
    const write=['drive.upload','gmail.send'].includes(request.operation);
    return submitResults(state.bridge,{schema:'workspace-recover/connector-results/v3',results:[{
      requestId:request.requestId,requestHash:request.requestHash,sessionId:request.sessionId,
      status:write?'unknown':'failed',error:typeof raw.error==='string'?raw.error:JSON.stringify(raw.error)}]});
  }
  const normalized={...raw,...(downloadPath?{path:path.resolve(downloadPath)}:{})};
  if(!normalized.id&&raw.message_id)normalized.id=raw.message_id;
  if(!normalized.id)throw new Error('Connector output has no object/message ID.');
  if(['drive.download','drive.metadata','gmail.read'].includes(request.operation)&&normalized.id!==request.payload.id)throw new Error('Connector output belongs to another requested object.');
  if(request.operation==='drive.download'){
    if(!normalized.path)throw new Error('Supply the exact materialized file path with --path.');
    normalized.observed=await fileRecord(normalized.path);
  }
  if(request.operation==='drive.upload'){
    const parent=raw.parent_id||raw.parent||raw.parent_ids?.[0];
    if(request.payload.folderId&&parent!==request.payload.folderId&&!raw.parents?.includes(request.payload.folderId))throw new Error('Upload response does not confirm the requested folder. Read metadata before submitting.');
    normalized.parent=parent;
  }
  if(request.operation==='gmail.read'){
    const file=path.join(state.directory,'received',request.requestId+'-body.txt');await fsp.mkdir(path.dirname(file),{recursive:true});
    await fsp.writeFile(file,raw.body??'',{mode:0o600});normalized.bodyFile=file;normalized.bodySha256=await sha256File(file);
    if(attachments.length){
      const seen=new Set();normalized.localAttachments=[];
      for(const a of attachments){
        if(!a.name||seen.has(a.name)||!(raw.attachments||[]).some(x=>(x.filename||x.name)===a.name))throw new Error('Attachment mapping is duplicate or absent in the actual parent message.');
        seen.add(a.name);normalized.localAttachments.push({name:a.name,...await fileRecord(a.path)});
      }
    }
  }
  const previousFile=path.join(state.bridge,'responses',request.requestId+'.json');
  const previous=await exists(previousFile)?await readJson(previousFile):null;
  const receipt=await submitResults(state.bridge,{schema:'workspace-recover/connector-results/v3',results:[{requestId:request.requestId,requestHash:request.requestHash,sessionId:request.sessionId,status:'completed',result:normalized,
    ...(previous?.status==='unknown'?{resolvesSha256:hash(previous)}:{})}]});
  if(state.pending?.observation?.code==='REMOTE_OUTCOME_UNKNOWN'){
    state.observations.push(observation('REMOTE_OUTCOME_RECONCILED','The host returned an actual provider outcome.',{stepId:state.pending.stepId,requestId:request.requestId}));
    state.pending=null;state.status='WAITING_HOST';await persist(state);
  }
  return receipt;
}

export async function recordPresented({directory,requestId}) {
  directory=path.resolve(directory);
  return withLock(directory,async()=>{
    const state=await readJson(path.join(directory,'state.json'));
    if(!state.pending||state.pending.requestId!==requestId)throw new Error('No matching current-stage question.');
    state.pending.presented=true;await persist(state);return view(state);
  });
}
