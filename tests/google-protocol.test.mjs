import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { GoogleWorkspaceProvider, authorizeGoogleWorkspace } from '../src/providers/google-workspace.mjs';
import { startBackupFromManifest } from '../src/core/backup.mjs';
import { startRestore } from '../src/core/restore.mjs';
const tmp=()=>fsp.mkdtemp(path.join(os.tmpdir(),'wr-google-protocol-'));
const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const b64=data=>Buffer.from(data).toString('base64url');
async function withGoogle(body,{expired=false}={}) {
 const d=await tmp(), oldConfig=process.env.WORKSPACE_RECOVER_CONFIG_DIR, oldFetch=globalThis.fetch;
 process.env.WORKSPACE_RECOVER_CONFIG_DIR=path.join(d,'config');
 const dir=path.join(process.env.WORKSPACE_RECOVER_CONFIG_DIR,'google-workspace','protocol');await fsp.mkdir(dir,{recursive:true});
 await fsp.writeFile(path.join(dir,'client.json'),JSON.stringify({installed:{client_id:'fixture-client',client_secret:'fixture-secret'}}));
 await fsp.writeFile(path.join(dir,'token.json'),JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:expired?0:Date.now()+3600000}));
 try{return await body({d,dir,oldFetch});}finally{globalThis.fetch=oldFetch;if(oldConfig===undefined)delete process.env.WORKSPACE_RECOVER_CONFIG_DIR;else process.env.WORKSPACE_RECOVER_CONFIG_DIR=oldConfig;}
}
test('032 Google protocol: Gmail request uses the documented v1 endpoint and attachment bytes',async()=>withGoogle(async({d})=>{
 const requests=[];globalThis.fetch=async(url,opts)=>{requests.push(String(url));assert.equal(new Headers(opts.headers).get('authorization'),'Bearer fixture-access');if(String(url).endsWith('/attachments/att'))return json({data:b64('{}')});assert.equal(String(url),'https://gmail.googleapis.com/gmail/v1/users/me/messages/1a0c71dbfb09ed40?format=full');return json({payload:{mimeType:'multipart/mixed',parts:[{filename:'workspace-recovery-manifest.json',body:{attachmentId:'att'}}]}});};
 const result=await new GoogleWorkspaceProvider({profile:'protocol'}).readHandoff('1a0c71dbfb09ed40',path.join(d,'handoff'));assert.equal(await fsp.readFile(result.attachments['workspace-recovery-manifest.json'],'utf8'),'{}');assert.equal(requests.length,2);
}));
test('032 Google protocol: expired token refresh is stored and API failure retains AUTH_REQUIRED',async()=>withGoogle(async({dir})=>{
 globalThis.fetch=async(url,opts)=>{assert.equal(String(url),'https://oauth2.googleapis.com/token');assert.equal(opts.body.get('refresh_token'),'fixture-refresh');return json({access_token:'refreshed',expires_in:3600});};
 await new GoogleWorkspaceProvider({profile:'protocol'}).ready();const t=JSON.parse(await fsp.readFile(path.join(dir,'token.json')));assert.equal(t.access_token,'refreshed');assert.equal(t.refresh_token,'fixture-refresh');assert.equal((await fsp.stat(path.join(dir,'token.json'))).mode&0o777,0o600);
 await fsp.writeFile(path.join(dir,'token.json'),JSON.stringify({...t,expires_at:0}));globalThis.fetch=async()=>new Response(JSON.stringify({error:'invalid_grant'}),{status:400});await assert.rejects(new GoogleWorkspaceProvider({profile:'protocol'}).ready(),e=>e.code==='AUTH_REQUIRED');
},{expired:true}));
test('032 Google protocol: Drive parent check blocks media download from another folder',async()=>withGoogle(async({d})=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return json({id:'f',parents:['other']});};await assert.rejects(new GoogleWorkspaceProvider({profile:'protocol'}).download({id:'f'},path.join(d,'download'),{expectedFolderId:'expected'}),/expected folder/);assert.equal(calls,1);
}));
test('032 Google protocol: resumable upload cannot send a bearer token to a foreign Location',async()=>withGoogle(async({d})=>{
 const p=path.join(d,'data');await fsp.writeFile(p,'bytes');let calls=0;globalThis.fetch=async()=>{calls++;return new Response(null,{headers:{location:'https://attacker.invalid/upload'}});};await assert.rejects(new GoogleWorkspaceProvider({profile:'protocol',driveFolderId:'folder'}).upload(p),/upload.*(URL|endpoint|location)/i);assert.equal(calls,1);
}));
test('032 Google protocol: duplicate recovery attachment names never silently overwrite',async()=>withGoogle(async({d})=>{
 globalThis.fetch=async()=>json({payload:{parts:[{filename:'workspace-recovery-manifest.json',body:{data:b64('{}')}},{filename:'workspace-recovery-manifest.json',body:{data:b64('{"tampered":true}')}}]}});await assert.rejects(new GoogleWorkspaceProvider({profile:'protocol'}).readHandoff('1a0c71dbfb09ed40',path.join(d,'h')),/duplicate.*attachment/i);
}));
test('032 Google protocol: outgoing MIME headers cannot inject recipients',async()=>withGoogle(async()=>{
 let called=false;globalThis.fetch=async()=>{called=true;return json({id:'id'});};await assert.rejects(new GoogleWorkspaceProvider({profile:'protocol'}).sendHandoff({to:'operator@example.test\r\nBcc: other@example.test',subject:'test',body:'test',attachments:[]}),/header/);assert.equal(called,false);
}));
// Whole real adapter exercised against deterministic in-process Google protocol fixtures.
// No network/account OAuth result is claimed by this test.
test('032 Google protocol: native backup, remote roundtrip, Gmail handoff and restore share the actual adapter',async()=>withGoogle(async({d})=>{
 const files=new Map(),messages=new Map(),pending=new Map();let counter=0;
 async function bytes(body){if(typeof body==='string'||Buffer.isBuffer(body))return Buffer.from(body);const chunks=[];for await(const chunk of body)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}
 globalThis.fetch=async(url,options={})=>{
  const u=new URL(String(url));assert.equal(new Headers(options.headers).get('authorization'),'Bearer fixture-access');
  if(u.hostname==='www.googleapis.com' && u.pathname==='/upload/drive/v3/files' && options.method==='POST'){const metadata=JSON.parse(options.body);assert.deepEqual(metadata.parents,['folder']);const id=`file-${++counter}`;pending.set(id,metadata);return new Response(null,{headers:{location:`https://www.googleapis.com/upload/drive/v3/files?upload_id=${id}`}});}
  if(u.hostname==='www.googleapis.com' && options.method==='PUT'){const id=u.searchParams.get('upload_id'),meta=pending.get(id),data=await bytes(options.body);files.set(id,{...meta,data});return json({id,name:meta.name,size:String(data.length),parents:meta.parents});}
  if(u.hostname==='www.googleapis.com' && u.pathname.startsWith('/drive/v3/files/')){const id=u.pathname.split('/').at(-1),f=files.get(id);assert.ok(f);if(u.searchParams.get('alt')==='media')return new Response(f.data);return json({id,name:f.name,size:String(f.data.length),parents:f.parents});}
  if(u.hostname==='gmail.googleapis.com' && u.pathname==='/gmail/v1/users/me/messages/send'){const raw=Buffer.from(JSON.parse(options.body).raw,'base64url').toString();const boundary=raw.match(/boundary="([^"]+)"/)[1];const parts=raw.split(`--${boundary}`).flatMap(s=>{const match=s.match(/filename="([^"]+)"\r\n\r\n([\s\S]*?)\r\n$/);return match?[{filename:match[1],mimeType:'application/json',body:{data:Buffer.from(match[2].replace(/\s/g,''),'base64').toString('base64url')}}]:[];});const id='1a0c71dbfb09ed40';messages.set(id,{payload:{headers:[{name:'Subject',value:raw.match(/^Subject: (.*)$/m)[1].trim()},{name:'To',value:raw.match(/^To: (.*)$/m)[1].trim()}],parts:[{mimeType:'text/plain',body:{data:b64(raw.split(`--${boundary}`)[1].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/,''))}},...parts]}});return json({id,threadId:id});}
  if(u.hostname==='gmail.googleapis.com' && u.pathname==='/gmail/v1/users/me/messages/1a0c71dbfb09ed40')return json(messages.get('1a0c71dbfb09ed40'));
  throw new Error(`Unexpected Google protocol route: ${u}`);
 };
 await fsp.mkdir(path.join(d,'source'));await fsp.writeFile(path.join(d,'source','state'),'actual-data');const m={schema:'workspace-recover/manifest/v3',name:'protocol',backup:{source:{path:path.join(d,'source')},provider:{type:'google-workspace',profile:'protocol',folderId:'folder'}},restore:{workflow:[]},handoff:{provider:{type:'google-workspace',profile:'protocol'},to:'operator@example.test',subject:'rebranding'}};
 const mp=path.join(d,'manifest.json');await fsp.writeFile(mp,JSON.stringify(m));const b=await startBackupFromManifest({manifestPath:mp,stateRoot:path.join(d,'state')});assert.equal(b.state,'completed');assert.ok(files.size>0);assert.ok(messages.size>0);
 const r=await startRestore({handoff:b.handoff.url,googleProfile:'protocol',target:path.join(d,'restore'),stateRoot:path.join(d,'state')});assert.equal(r.state,'completed');assert.equal(await fsp.readFile(path.join(d,'restore/state'),'utf8'),'actual-data');
}));
test('032 Google protocol: loopback authorization binds PKCE verifier to the displayed challenge',async()=>withGoogle(async({dir,oldFetch})=>{
 const originalWrite=process.stdout.write;let authUrl, tokenBody;
 globalThis.fetch=async(url,options={})=>{assert.equal(String(url),'https://oauth2.googleapis.com/token');tokenBody=options.body;return json({access_token:'fixture-new',refresh_token:'fixture-new-refresh',expires_in:3600});};
 process.stdout.write=function(chunk,...args){
  const text=String(chunk);const found=text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?\S+/);
  if(found){authUrl=new URL(found[0]);const callback=new URL(authUrl.searchParams.get('redirect_uri'));callback.searchParams.set('state',authUrl.searchParams.get('state'));callback.searchParams.set('code','fixture-authorization-code');setImmediate(()=>oldFetch(callback).catch(()=>{}));return true;}
  return originalWrite.call(this,chunk,...args);
 };
 try{
  const result=await authorizeGoogleWorkspace({profile:'protocol',noBrowser:true,timeoutMs:10000});
  const {createHash}=await import('node:crypto');const verifier=tokenBody.get('code_verifier');
  assert.ok(verifier);assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256');assert.equal(createHash('sha256').update(verifier).digest('base64url'),authUrl.searchParams.get('code_challenge'));
  assert.equal(tokenBody.get('code'),'fixture-authorization-code');assert.equal(result.tokenPath,path.join(dir,'token.json'));
 } finally{process.stdout.write=originalWrite;}
}));
