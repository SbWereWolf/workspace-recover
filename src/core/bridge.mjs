import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { assertFormat, schema } from './formats.mjs';
import { ensureDir, nowIso, pathExists, readJson, sha256Text, writeJsonAtomic } from './util.mjs';

export const BRIDGE_OPERATIONS = Object.freeze(['drive.upload', 'drive.download', 'drive.metadata', 'gmail.send', 'gmail.read']);
const requestPattern = /^rq_[a-f0-9]{64}$/;
const sessionPattern = /^wr_[bri]_\d{14}_[a-f0-9]{12}$/;
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function plain(value) { return value && typeof value==='object' && !Array.isArray(value); }
function required(condition,message) { if(!condition)throw new Error(message); }
export function validateCapabilities(document) {
  assertFormat(document,'bridge-capabilities');
  required(typeof document.account==='string' && /^[^\s@]+@[^\s@]+$/.test(document.account),'bridge account is required');
  required(Array.isArray(document.operations) && document.operations.length>0 && document.operations.every(x=>BRIDGE_OPERATIONS.includes(x)),'invalid bridge operations');
  if(document.dispatchCommand!==undefined)required(Array.isArray(document.dispatchCommand) && document.dispatchCommand.length && document.dispatchCommand.every(x=>typeof x==='string' && x && !x.includes('\0')),'invalid dispatchCommand argv');
  return document;
}
export async function initializeBridge(root,capabilities) {
  validateCapabilities(capabilities);root=path.resolve(root);
  await fsp.mkdir(root,{recursive:true,mode:0o700});
  const stat=await fsp.lstat(root);required(stat.isDirectory()&&!stat.isSymbolicLink(),'bridge must be a real private directory');
  await fsp.chmod(root,0o700);
  // Never overwrite the operator's existing capability/identity declaration.
  await fsp.writeFile(path.join(root,'capabilities.json'),JSON.stringify(capabilities,null,2)+'\n',{flag:'wx',mode:0o600});
  for(const sub of ['requests','responses','resolutions'])await fsp.mkdir(path.join(root,sub),{mode:0o700});
  return {schema:schema('bridge-location'),root,account:capabilities.account};
}
async function immutable(file,document) {
  const text=JSON.stringify(document,null,2)+'\n';
  // Atomic publish without replacing a concurrently published record.
  const temp=`${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fsp.writeFile(temp,text,{flag:'wx',mode:0o600});
  try { await fsp.link(temp,file); }
  catch(error) { if(error.code!=='EEXIST')throw error; if(canonical(await readJson(file))!==canonical(document))throw new Error(`conflicting immutable record: ${path.basename(file)}`); }
  finally {await fsp.rm(temp,{force:true});}
}
function requestFile(root,id) {required(requestPattern.test(id),'invalid connector request ID');return path.join(root,'requests',`${id}.json`);}
async function effectiveResponse(root,id) {
  const resolved=path.join(root,'resolutions',`${id}.json`);
  if(await pathExists(resolved))return readJson(resolved);
  const file=path.join(root,'responses',`${id}.json`);
  return await pathExists(file)?readJson(file):null;
}
export async function pendingRequests(root,{sessionId=null}={}) {
  root=path.resolve(root);const directory=path.join(root,'requests');
  if(!await pathExists(directory))return {schema:schema('connector-request-batch'),requests:[]};
  const requests=[];
  for(const file of (await fsp.readdir(directory)).sort()) {
    if(!/^rq_[a-f0-9]{64}\.json$/.test(file))continue;
    const r=assertFormat(await readJson(path.join(directory,file)),'connector-request');
    if(sessionId && r.sessionId!==sessionId)continue;
    const answer=await effectiveResponse(root,r.requestId);
    if(answer)continue; // An unknown remote outcome is reconciled, never resent.
    requests.push(r);
  }
  return {schema:schema('connector-request-batch'),requests};
}
export async function submitResults(root,document) {
  root=path.resolve(root);assertFormat(document,'connector-results');
  required(Array.isArray(document.results)&&document.results.length>0,'results must be a nonempty batch');
  const prepared=[],seen=new Set();
  for(const item of document.results) {
    required(plain(item)&&requestPattern.test(item.requestId),'invalid result request ID');
    required(!seen.has(item.requestId),'duplicate result request ID');seen.add(item.requestId);
    const request=assertFormat(await readJson(requestFile(root,item.requestId)),'connector-request');
    required(item.sessionId===request.sessionId && item.requestHash===request.requestHash,'connector response does not match frozen request/session');
    required(['completed','failed','unknown'].includes(item.status),'invalid connector result status');
    if(item.status==='completed')required(plain(item.result),'completed response requires result object');
    else required(typeof item.error==='string' && item.error.length>0,'failed/unknown response requires error');
    const response={schema:schema('connector-response'),...item};
    const previous=await effectiveResponse(root,item.requestId);
    let directory='responses';
    if(previous) {
      if(canonical(previous)===canonical(response)){prepared.push({duplicate:true,id:item.requestId});continue;}
      required(previous.status==='unknown' && item.resolvesSha256===sha256Text(canonical(previous)),'conflicting response; only an explicitly bound unknown outcome can be reconciled');
      required(item.status!=='unknown','reconciliation must resolve the outcome');directory='resolutions';
    } else required(!item.resolvesSha256,'unexpected reconciliation without prior unknown outcome');
    prepared.push({file:path.join(root,directory,`${item.requestId}.json`),response,id:item.requestId});
  }
  // Validate the whole batch before publishing any response.
  for(const item of prepared)if(!item.duplicate)await immutable(item.file,item.response);
  return {schema:schema('connector-results-receipt'),accepted:prepared.map(x=>x.id),duplicates:prepared.filter(x=>x.duplicate).length};
}

export class ConnectorBoundary extends Error {
  constructor(message,code,request=null) {super(message);this.code=code;this.request=request;}
}

/** A host-agent file bridge is not a fabricated API to the agent's connectors. */
export class ConnectorBridge {
  constructor({root,sessionId,mode='connector',waitTimeoutMs=1800000,onPending=null,onResolved=null,requiredOperations=[],account=null}) {
    required(typeof root==='string'&&root.length>0,'connector bridge directory is required');
    required(sessionPattern.test(sessionId),'connector requires a real session ID');
    required(['connector','delegated'].includes(mode),'invalid bridge mode');
    required(Number.isSafeInteger(waitTimeoutMs)&&waitTimeoutMs>0,'bridge timeout must be positive');
    Object.assign(this,{root:path.resolve(root),sessionId,mode,waitTimeoutMs,onPending,onResolved,requiredOperations,account});
  }
  async ready() {
    const file=path.join(this.root,'capabilities.json');
    if(!await pathExists(file))throw new ConnectorBoundary('Host connector bridge is not registered','CAPABILITY_REQUIRED');
    const stat=await fsp.lstat(this.root);required(stat.isDirectory()&&!stat.isSymbolicLink(),'bridge must be a real directory');
    this.capabilities=validateCapabilities(await readJson(file));
    if(this.account && this.account!==this.capabilities.account)throw new Error('connector account does not match configured account');
    const missing=this.requiredOperations.filter(x=>!this.capabilities.operations.includes(x));
    if(missing.length)throw new ConnectorBoundary(`Missing host capabilities: ${missing.join(', ')}`,'CAPABILITY_REQUIRED');
    return {ready:true,executor:this.mode,account:this.capabilities.account};
  }
  async perform(operation,payload) {
    if(!this.capabilities)await this.ready();
    if(!this.capabilities.operations.includes(operation))throw new ConnectorBoundary(`Missing host capability: ${operation}`,'CAPABILITY_REQUIRED');
    const identity={sessionId:this.sessionId,account:this.capabilities.account,operation,payload};
    const requestHash=sha256Text(canonical(identity)),requestId=`rq_${requestHash}`;
    const file=requestFile(this.root,requestId);
    let request;
    if(await pathExists(file)) {request=assertFormat(await readJson(file),'connector-request');required(request.requestHash===requestHash,'request fingerprint changed');}
    else {request={schema:schema('connector-request'),...identity,requestId,requestHash,createdAt:nowIso()};await immutable(file,request);}
    let answer=await effectiveResponse(this.root,requestId);
    if(!answer) {
      if(this.onPending)await this.onPending(request,this.root);
      if(this.mode==='delegated')throw new ConnectorBoundary('External operation awaits the host agent','EXTERNAL_PENDING',request);
      if(this.capabilities.dispatchCommand)await this.dispatch(request,file);
      const start=Date.now();
      while(!(answer=await effectiveResponse(this.root,requestId))) {
        if(Date.now()-start>=this.waitTimeoutMs)throw new ConnectorBoundary('Connector response timeout; pending request retained','EXTERNAL_PENDING',request);
        await delay(100);
      }
    }
    assertFormat(answer,'connector-response');
    required(answer.requestHash===requestHash&&answer.sessionId===this.sessionId,'response binding mismatch');
    if(answer.status==='unknown')throw new ConnectorBoundary(`External outcome unknown: ${answer.error}`,'EXTERNAL_OUTCOME_UNKNOWN',request);
    if(answer.status!=='completed')throw new Error(`Connector ${operation} failed: ${answer.error}`);
    if(this.onResolved)await this.onResolved(request,answer);
    return answer.result;
  }
  async dispatch(request,requestPath) {
    const resultPath=path.join(this.root,`${request.requestId}.dispatcher-results.json`);
    const claimPath=path.join(this.root,`${request.requestId}.dispatch-started.json`);
    if(await pathExists(claimPath))throw new ConnectorBoundary('Dispatcher was already started; reconcile its outcome instead of replaying','EXTERNAL_OUTCOME_UNKNOWN',request);
    await immutable(claimPath,{schema:schema('connector-dispatch-claim'),requestId:request.requestId,startedAt:nowIso()});
    const argv=this.capabilities.dispatchCommand;
    const child=spawn(argv[0],[...argv.slice(1),requestPath,resultPath],{shell:false,stdio:['ignore','ignore','pipe']});
    let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-8192);});
    const exit=await new Promise(resolve=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');},this.waitTimeoutMs);
      child.once('error',error=>{clearTimeout(timer);resolve({error});});
      child.once('close',code=>{clearTimeout(timer);resolve({code});});
    });
    if(exit.error || exit.code!==0 || !await pathExists(resultPath)) {
      const error=`Host dispatcher outcome is unknown: ${exit.error?.message||stderr||'no successful results file'}`;
      await submitResults(this.root,{schema:schema('connector-results'),results:[{requestId:request.requestId,requestHash:request.requestHash,sessionId:request.sessionId,status:'unknown',error}]});
      throw new ConnectorBoundary(error,'EXTERNAL_OUTCOME_UNKNOWN',request);
    }
    await submitResults(this.root,await readJson(resultPath));
  }
}
