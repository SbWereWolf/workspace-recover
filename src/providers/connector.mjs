import path from 'node:path';
import fsp from 'node:fs/promises';
import { ConnectorBridge } from '../core/bridge.mjs';
import { driveId, gmailMessageId } from './google-workspace.mjs';
import { copyFileVerified, ensureDir, sha256File, writeTextAtomic } from '../core/util.mjs';
const names=new Set(['workspace-handoff.json','workspace-recovery-manifest.json','workspace-transport-manifest.json','workspace-backup-receipt.json','workspace-rehearsal-receipt.json']);
const need=(condition,message)=>{if(!condition)throw new Error(message);};

/** Google resources, transported by the authorized host rather than OAuth here. */
export class ConnectorProvider {
  constructor(config) {
    this.type='google-workspace';this.executor=config.executor;this.sessionDir=config.sessionDir;
    need(this.sessionDir,'connector provider requires a session directory');
    this.config=config;this.bridge=new ConnectorBridge({root:config.bridge,sessionId:config.sessionId,mode:config.executor,waitTimeoutMs:config.waitTimeoutMs,
      requiredOperations:config.requiredOperations,account:config.account,onPending:config.onPending,onResolved:config.onResolved});
  }
  async ready(){return this.bridge.ready();}
  async upload(file,{name=path.basename(file),folderId=this.config.folderId}={}) {
    const artifact={path:path.resolve(file),name,bytes:(await fsp.stat(file)).size,sha256:await sha256File(file)};
    const folder=driveId(folderId);need(folder,'upload requires Drive folder ID');
    const result=await this.bridge.perform('drive.upload',{artifact,folderId:folder,sharing:'preserve'});
    const id=driveId(result.id);need(id,'upload response requires ID');
    need(result.parent===folder || result.parents?.includes(folder),'uploaded object is not in requested folder');
    need(Number(result.bytes)===artifact.bytes,'upload response size mismatch');
    return {id,url:result.url,name,bytes:artifact.bytes,sha256:artifact.sha256,parent:folder};
  }
  async metadata(ref) {
    const id=driveId(ref.id||ref.url||ref);const result=await this.bridge.perform('drive.metadata',{id});
    need(result.id===id,'metadata response ID mismatch');return result;
  }
  async download(ref,destination,{expectedFolderId=null,expectedBytes=null,expectedSha256=null}={}) {
    const id=driveId(ref.id||ref.url||ref);
    const result=await this.bridge.perform('drive.download',{id,expectedFolderId:expectedFolderId?driveId(expectedFolderId):null,expectedBytes,expectedSha256});
    need(result.id===id,'download response ID mismatch');
    if(expectedFolderId)need(result.parent===driveId(expectedFolderId)||result.parents?.includes(driveId(expectedFolderId)),'download object outside requested folder');
    const stat=await fsp.lstat(result.path);need(stat.isFile()&&!stat.isSymbolicLink(),'download response must identify a regular local file');
    if(expectedBytes!==null)need(stat.size===expectedBytes,'download size mismatch');
    if(expectedSha256!==null)need(await sha256File(result.path)===expectedSha256,'download SHA256 mismatch');
    await ensureDir(path.dirname(destination));await copyFileVerified(result.path,destination);return destination;
  }
  async sendHandoff({sessionId,to,subject,body,attachments}) {
    const dir=await ensureDir(path.join(this.sessionDir,'outgoing-mail'));
    const bodyFile=path.join(dir,'body.txt');await writeTextAtomic(bodyFile,body);
    const copied=[];
    for(const a of attachments) {
      need(names.has(a.name),'unsupported handoff attachment name');
      const file=path.join(dir,a.name);await copyFileVerified(a.path,file);
      copied.push({name:a.name,path:file,bytes:(await fsp.stat(file)).size,sha256:await sha256File(file),mimeType:a.mimeType});
    }
    const result=await this.bridge.perform('gmail.send',{sessionId,to:typeof to==='string'?to.split(',').map(x=>x.trim()):to,subject,contentType:'text/plain',bodyFile,bodySha256:await sha256File(bodyFile),attachments:copied});
    const id=gmailMessageId(result.id);need(id,'send response requires message ID');return {...result,id};
  }
  async readHandoff(reference,destinationDirectory) {
    const id=gmailMessageId(reference);need(id,'invalid Gmail reference');
    const result=await this.bridge.perform('gmail.read',{id,attachmentNames:[...names]});
    need(result.id===id,'Gmail readback ID mismatch');need(typeof result.subject==='string'&&typeof result.body==='string'&&Array.isArray(result.to),'Gmail readback requires subject, body and recipients');need(Array.isArray(result.attachments),'Gmail response attachments must be an array');
    await ensureDir(destinationDirectory);const attachments={};
    for(const a of result.attachments) {
      need(typeof a.name==='string'&&!/[\\/\0]/.test(a.name),'unsafe attachment name');
      if(!names.has(a.name))continue;
      need(!Object.hasOwn(attachments,a.name),'duplicate handoff attachment');
      const stat=await fsp.lstat(a.path);need(stat.isFile()&&!stat.isSymbolicLink(),'attachment must be a regular local file');
      const target=path.join(destinationDirectory,a.name);await copyFileVerified(a.path,target);attachments[a.name]=target;
    }
    return {id,body:result.body,subject:result.subject,to:result.to,attachments,providerAttestation:'host-connector'};
  }
}
