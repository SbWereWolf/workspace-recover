import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import {assertFormat,schema} from './formats.mjs';
import {createTarGz,extractTarGz,verifyTarInventory} from './archive.mjs';
import {selectionInventory,assertInventory,fileIdentity,sameIdentity} from './selection.mjs';
import {archiveName} from './tar-format.mjs';
import {TargetTree} from './target-tree.mjs';
import {executeWorkflow,validateWorkflow} from './workflow.mjs';
import {ensureDir,sha256File,pathExists} from './util.mjs';

export const PROFILE_PLACEHOLDERS=['sourceRoot','targetRoot','archivePath','selectionNul','workspace','stepDir','operation'];
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const HASH=/^[a-f0-9]{64}$/;
const FORMAT=/^[a-z0-9][a-z0-9.-]{0,31}$/;

/** Explicit trusted command pairs are not an OS sandbox and do not inherit safe-merge guarantees. */
export function validateArchiveProfile(profile,{resolved=false}={}) {
  if(profile===undefined)return null;
  assertFormat(profile,'archive-profile');
  if(profile.kind!=='exec'||!FORMAT.test(profile.format||''))throw new Error('invalid archive profile kind or format');
  if(!Array.isArray(profile.bootstrap??[]))throw new Error('profile bootstrap must be an array');
  const ids=new Set();
  for(const b of profile.bootstrap??[]){
    if(!b||!ID.test(b.id)||['constructor','prototype','__proto__'].includes(b.id)||ids.has(b.id))throw new Error('invalid bootstrap ID');ids.add(b.id);
    if(resolved){if(!Number.isSafeInteger(b.bytes)||b.bytes<0||!HASH.test(b.sha256||'')||typeof b.remote?.id!=='string'||!b.remote.id||!Number.isInteger(b.mode)||b.mode<0||b.mode>0o777)throw new Error('invalid resolved bootstrap reference');}
    else if(typeof b.path!=='string'||!b.path||b.path.includes('\0')||(b.sha256!==undefined&&!HASH.test(b.sha256)))throw new Error('invalid bootstrap source');
  }
  const allowed=new Set([...PROFILE_PLACEHOLDERS,...[...ids].map(x=>'bootstrap.'+x)]);
  for(const name of ['pack','unpack']){
    const command=profile[name];if(!command||typeof command!=='object')throw new Error(`archive profile requires ${name}`);
    if(command.shell!==undefined)throw new Error('archive profile does not accept shell strings');
    validateWorkflow([{...command,id:name,type:'command'}]);
    const strings=v=>typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(strings):v&&typeof v==='object'?Object.values(v).flatMap(strings):[];
    for(const s of strings(command))for(const m of s.matchAll(/\$\{([^}]+)\}/g))if(!allowed.has(m[1]))throw new Error(`unknown archive profile placeholder: ${m[1]}`);
    const forbidden=name==='pack'?'targetRoot':'sourceRoot';
    if(strings(command).some(s=>s.includes('${'+forbidden+'}')))throw new Error(`${name} cannot depend on ${forbidden}`);
  }
  const programs=profile.requires?.executables??[];
  if(!Array.isArray(programs)||programs.some(x=>typeof x!=='string'||!x||x.includes('\0')))throw new Error('invalid profile executable requirements');
  return structuredClone(profile);
}

async function executable(name) {
  const paths=name.includes(path.sep)?[path.resolve(name)]:(process.env.PATH||'').split(path.delimiter).map(p=>path.join(p,name));
  for(const p of paths){try{await fsp.access(p,fs.constants.X_OK);if((await fsp.stat(p)).isFile())return p;}catch{}}
  throw new Error(`required archive executable not found: ${name}`);
}
export async function requireExecutables(profile){for(const p of profile?.requires?.executables??[])await executable(p);}

async function regularHash(file,expected=null) {
  const h=await fsp.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{const before=await h.stat();if(!before.isFile()||(expected&&!sameIdentity(expected,before)))throw new Error(`source changed or not a regular file: ${file}`);
    const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);let total=0;
    while(true){const r=await h.read(buffer,0,buffer.length,null);if(!r.bytesRead)break;hash.update(buffer.subarray(0,r.bytesRead));total+=r.bytesRead;}
    if(total!==before.size||!sameIdentity(before,await h.stat()))throw new Error(`source changed during hashing: ${file}`);
    return {sha256:hash.digest('hex'),bytes:total,mode:before.mode&0o7777,identity:fileIdentity(before)};
  }finally{await h.close();}
}
async function sourceUnchanged(selection){for(const e of [...selection.entries,...selection.watched])if(!sameIdentity(e.identity,await fsp.lstat(e.absolute)))throw new Error(`source changed during external capture: ${e.name}`);}

/** Capture bootstrap before encoding; the decoder must not live only inside the unopened archive. */
export async function prepareBootstrap(profile,sessionDir) {
  const refs=[];
  for(const b of profile?.bootstrap??[]){
    const source=path.resolve(b.path),meta=await regularHash(source);
    if(b.sha256&&b.sha256!==meta.sha256)throw new Error(`bootstrap hash mismatch: ${b.id}`);
    const file=path.join(await ensureDir(path.join(sessionDir,'bootstrap')),b.id);
    if(await pathExists(file)){if(await sha256File(file)!==meta.sha256)throw new Error('frozen bootstrap changed');}
    else await fsp.copyFile(source,file,fs.constants.COPYFILE_EXCL);
    if(await sha256File(file)!==meta.sha256)throw new Error('bootstrap copy changed');
    await fsp.chmod(file,meta.mode&0o777);
    refs.push({id:b.id,path:file,bytes:meta.bytes,sha256:meta.sha256,mode:meta.mode&0o777});
  }
  return refs;
}
export function bootstrapContext(refs=[]){return Object.fromEntries(refs.map(b=>['bootstrap.'+b.id,b.path]));}
export function resolvedArchiveProfile(profile,refs=[]){if(!profile)return undefined;const result=structuredClone(profile);result.bootstrap=refs.map(({id,bytes,sha256,mode,remote})=>({id,bytes,sha256,mode,remote:{id:remote.id,url:remote.url,parent:remote.parent}}));return validateArchiveProfile(result,{resolved:true});}
export async function fetchBootstrap(profile,provider,directory,folder,fresh=false){
  const refs=[];
  const outcomes=await Promise.allSettled((profile?.bootstrap??[]).map(async b=>{
    const file=path.join(await ensureDir(path.join(directory,'bootstrap')),b.id);
    if(fresh||!await pathExists(file)||(await fsp.stat(file)).size!==b.bytes||await sha256File(file)!==b.sha256)await provider.download(b.remote,file,{expectedFolderId:folder,expectedBytes:b.bytes,expectedSha256:b.sha256});
    if((await fsp.stat(file)).size!==b.bytes||await sha256File(file)!==b.sha256)throw new Error(`bootstrap download mismatch: ${b.id}`);
    await fsp.chmod(file,b.mode);return {...b,path:file};
  }));
  const failed=outcomes.find(x=>x.status==='rejected');if(failed)throw failed.reason;
  refs.push(...outcomes.map(x=>x.value));return refs;
}
async function command(profile,name,context,workspace,sessionDir){
  const result=await executeWorkflow({steps:[{...profile[name],id:name,type:'command'}],workspace,sessionDir:path.join(sessionDir,name),context});
  if(result.hardFailure)throw new Error(`archive ${name} failed; exit=${result.results[0]?.exitCode}; see ${result.workflowReport.fullPath}`);
  return result.results[0].report;
}

export async function verifyArchiveInventory(archive,inventory){
  const room=await fsp.mkdtemp(path.join(os.tmpdir(),'workspace-recover-inventory-'));let handle;
  try{const spool=path.join(room,'archive.tar');await pipeline(fs.createReadStream(archive),zlib.createGunzip(),fs.createWriteStream(spool,{flags:'wx',mode:0o600}));handle=await fsp.open(spool,'r');await verifyTarInventory(handle,inventory);}
  finally{if(handle)await handle.close();await fsp.rm(room,{recursive:true,force:true});}
}
export async function packArchive({profile,source,output,selection,selectionFile,sessionDir,bootstrap=[]}){
  if(!profile)return createTarGz({source,output,selection});
  validateArchiveProfile(profile);await requireExecutables(profile);
  const parent=await fsp.realpath(path.dirname(output)),actual=path.join(parent,path.basename(output));
  if(actual===selection.sourceRoot||actual.startsWith(selection.sourceRoot+path.sep))throw new Error('archive output must be outside source');
  if(await fsp.lstat(output).catch(e=>e.code==='ENOENT'?null:Promise.reject(e)))throw new Error('archive output already exists');
  for(const e of selection.entries)if(e.type==='0')e.sha256=(await regularHash(e.absolute,e.identity)).sha256;
  const inventory=assertInventory(selectionInventory(selection));
  const report=await command(profile,'pack',{sourceRoot:selection.sourceRoot,selectionNul:selectionFile,archivePath:output,operation:'pack',...bootstrapContext(bootstrap)},selection.sourceRoot,sessionDir);
  await sourceUnchanged(selection);
  const captured=await regularHash(output);
  if(profile.format==='tar.gz')await verifyArchiveInventory(output,inventory);
  return {output,bytes:captured.bytes,sha256:captured.sha256,entries:selection.entries.map(e=>e.name),inventory,packReport:report};
}

/** Inventory comparison is pre-workflow recovery validation, never test-mutation policing. */
export async function verifyWorkspaceInventory(target,inventory,{allowExtra=false}={}){
  assertInventory(inventory);
  const expected=new Map(inventory.entries.map(e=>[e.path,e]));
  const seen=new Set();
  async function visit(relative){const file=relative==='.'?target:path.join(target,relative),stat=await fsp.lstat(file),e=expected.get(relative);seen.add(relative);
    if(!e){if(!allowExtra)throw new Error(`unexpected restored inventory path: ${relative}`);return;}
    const type=stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'unsupported';
    if(type!==e.type||(stat.mode&0o7777)!==e.mode)throw new Error(`restored inventory type/mode mismatch: ${relative}`);
    if(type==='file'){const meta=await regularHash(file,fileIdentity(stat));if(meta.bytes!==e.bytes||meta.sha256!==e.sha256)throw new Error(`restored inventory bytes mismatch: ${relative}`);}
    if(type==='symlink'){if(!e.target||path.posix.isAbsolute(e.target)||/^[A-Za-z]:/.test(e.target))throw new Error('unsafe restored inventory link');archiveName(path.posix.normalize(path.posix.join(path.posix.dirname(e.path),e.target)));if(await fsp.readlink(file)!==e.target)throw new Error(`restored inventory link mismatch: ${relative}`);}
    if(type==='directory')for(const n of await fsp.readdir(file))await visit(relative==='.'?n:relative+'/'+n);
  }
  await visit('.');for(const name of expected.keys())if(!seen.has(name))throw new Error(`missing restored inventory path: ${name}`);
}
export async function unpackArchive({profile,archive,destination,rejectExisting,inventory,sessionDir,bootstrap=[]}){
  if(!profile){await extractTarGz({archive,destination,rejectExisting,inventory});return null;}
  validateArchiveProfile(profile,{resolved:true});await requireExecutables(profile);
  if(!inventory)throw new Error('external archive profile requires selection inventory');
  assertInventory(inventory);
  for(const e of inventory.entries)if(e.type==='symlink'){if(!e.target||path.posix.isAbsolute(e.target)||/^[A-Za-z]:/.test(e.target))throw new Error('unsafe inventory symlink');archiveName(path.posix.normalize(path.posix.join(path.posix.dirname(e.path),e.target)));}
  if(profile.format==='tar.gz')await verifyArchiveInventory(archive,inventory);
  // Arbitrary external programs are trusted. Preflight is not an OS confinement mechanism.
  // A merge into an existing tree would bypass our per-entry kernel boundary: reject it explicitly.
  if(!rejectExisting)throw new Error('external archive profiles require a new target; use builtin for safe merge');
  const tree=await TargetTree.open(destination,true);await tree.close();
  const list=path.join(sessionDir,'unpack-selection.nul');await fsp.writeFile(list,Buffer.from(inventory.entries.map(e=>e.path).join('\0')+'\0'),{mode:0o600});
  const report=await command(profile,'unpack',{targetRoot:path.resolve(destination),archivePath:archive,selectionNul:list,operation:'unpack',...bootstrapContext(bootstrap)},destination,sessionDir);
  await verifyWorkspaceInventory(destination,inventory);return report;
}
