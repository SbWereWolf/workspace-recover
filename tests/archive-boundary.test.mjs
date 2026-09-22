import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTarGz, extractTarGz } from '../src/core/archive.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'bin/workspace-recover.mjs');
const ERP_PATH='tasks/03-in-progress/1701-ui-simplification/evidence/checks/chk_20260922T021207Z_ddac93655d/evidence/test-results/suites-browser-contracts-d-2d5b1-cal-terminal-action-failure-firefox/terminal-evidence/terminal-technical-failure-after.png';
async function fixture(t) {
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wr-boundary-'));
 t.after(async()=>{ async function chmod(p){const s=await fsp.lstat(p);if(s.isDirectory()&&!s.isSymbolicLink()){await fsp.chmod(p,0o700);for(const n of await fsp.readdir(p))await chmod(path.join(p,n));}} await chmod(root);await fsp.rm(root,{recursive:true,force:true}); });
 const source=path.join(root,'source');await fsp.mkdir(path.join(source,'data'),{recursive:true});await fsp.writeFile(path.join(source,'data/value'),'BACKUP_VALUE');
 return {root,source,archive:path.join(root,'a.tar.gz'),destination:path.join(root,'target')};
}
function cli(f,...args) {return spawnSync(process.execPath,[CLI,...args,'--state-dir',path.join(f.root,'state')],{encoding:'utf8',timeout:15000});}
async function backup(f) {
 const manifest={schema:'workspace-recover/manifest/v3',name:'boundary-fixture',backup:{source:{path:f.source,exclude:[]},provider:{type:'local-files',root:path.join(f.root,'objects')}},restore:{existingTarget:'reject',workflow:[]},handoff:{provider:{type:'local-files',root:path.join(f.root,'objects')},subject:'test'}};
 const p=path.join(f.root,'backup.json');await fsp.writeFile(p,JSON.stringify(manifest));const result=cli(f,'backup',p);
 assert.equal(result.status,0,result.stdout+result.stderr);
 const ids=await fsp.readdir(path.join(f.root,'state/sessions'));const id=ids.find(n=>n.startsWith('wr_b_'));assert.ok(id);
 return JSON.parse(await fsp.readFile(path.join(f.root,'state/sessions',id,'workspace-recovery-manifest.json')));
}
for(const [label,name] of [['105-byte filename','a'.repeat(101)+'.txt'],['reported 237-byte ERP path',ERP_PATH],['long UTF-8 path','каталог/'.repeat(24)+'文'.repeat(70)+'.txt'],['newline and equals in long path','a'.repeat(110)+'\nkey=value.txt']]) {
 test(`public backup and restore roundtrip ${label}`,async t=>{
  const f=await fixture(t);const payload=Buffer.from('exact synthetic fixture\0\xff','latin1');await fsp.mkdir(path.dirname(path.join(f.source,name)),{recursive:true});await fsp.writeFile(path.join(f.source,name),payload);
  const manifest=await backup(f);const file=path.join(f.root,'restore.json');await fsp.writeFile(file,JSON.stringify(manifest));const p=cli(f,'restore','--manifest',file,'--target',f.destination);
  assert.equal(p.status,0,p.stdout+p.stderr);assert.deepEqual(await fsp.readFile(path.join(f.destination,name)),payload);
 });
}
test('long relative symlink target is preserved without truncation',async t=>{
 const f=await fixture(t);const name='a'.repeat(110);await fsp.writeFile(path.join(f.source,name),'target');await fsp.symlink(name,path.join(f.source,'link'));
 await createTarGz({source:f.source,output:f.archive});await extractTarGz(f);assert.equal(await fsp.readlink(path.join(f.destination,'link')),name);
});
for(const position of ['ancestor','leaf','root','above-root','dangling']) {
 test(`public merge refuses pre-existing ${position} symlink without changing outside bytes or mode`,async t=>{
  const f=await fixture(t);const m=await backup(f);m.restore.existingTarget='merge';const mp=path.join(f.root,'merge.json');await fsp.writeFile(mp,JSON.stringify(m));
  const outside=path.join(f.root,'outside');await fsp.mkdir(outside);const file=path.join(outside,'value');await fsp.writeFile(file,'SENTINEL');await fsp.chmod(file,0o640);await fsp.chmod(outside,0o750);
  if(position==='root')await fsp.symlink(outside,f.destination);
  else if(position==='above-root'){const parent=path.join(f.root,'link-parent');await fsp.symlink(outside,parent);f.destination=path.join(parent,'nested');}
  else{await fsp.mkdir(f.destination);if(position==='ancestor')await fsp.symlink(outside,path.join(f.destination,'data'));else{await fsp.mkdir(path.join(f.destination,'data'));await fsp.symlink(position==='dangling'?path.join(outside,'absent'):file,path.join(f.destination,'data/value'));}}
  const p=cli(f,'restore','--manifest',mp,'--target',f.destination);
  assert.notEqual(p.status,0,p.stdout+p.stderr);assert.equal(await fsp.readFile(file,'utf8'),'SENTINEL');assert.equal((await fsp.stat(file)).mode&0o7777,0o640);assert.equal((await fsp.stat(outside)).mode&0o7777,0o750);assert.equal(fs.existsSync(path.join(outside,'absent')),false);assert.equal(fs.existsSync(path.join(outside,'nested')),false);
 });
}
test('merge replaces a hardlinked leaf by a new inode without changing its external alias',async t=>{
 const f=await fixture(t);await createTarGz({source:f.source,output:f.archive});const outside=path.join(f.root,'outside');await fsp.writeFile(outside,'KEEP');await fsp.chmod(outside,0o640);await fsp.mkdir(path.join(f.destination,'data'),{recursive:true});await fsp.link(outside,path.join(f.destination,'data/value'));
 await extractTarGz({...f,rejectExisting:false});assert.equal(await fsp.readFile(outside,'utf8'),'KEEP');assert.equal((await fsp.stat(outside)).mode&0o7777,0o640);assert.equal(await fsp.readFile(path.join(f.destination,'data/value'),'utf8'),'BACKUP_VALUE');
});
test('safe merge preserves unrelated files and restores bytes/modes',async t=>{
 const f=await fixture(t);await fsp.chmod(path.join(f.source,'data/value'),0o444);await fsp.chmod(path.join(f.source,'data'),0o555);await createTarGz({source:f.source,output:f.archive});await fsp.mkdir(path.join(f.destination,'data'),{recursive:true});await fsp.writeFile(path.join(f.destination,'data/value'),'old');await fsp.writeFile(path.join(f.destination,'keep'),'unrelated');
 await extractTarGz({...f,rejectExisting:false});assert.equal(await fsp.readFile(path.join(f.destination,'keep'),'utf8'),'unrelated');assert.equal(await fsp.readFile(path.join(f.destination,'data/value'),'utf8'),'BACKUP_VALUE');assert.equal((await fsp.stat(path.join(f.destination,'data'))).mode&0o7777,0o555);assert.equal((await fsp.stat(path.join(f.destination,'data/value'))).mode&0o7777,0o444);
});
test('backup refuses output inside source before touching an existing file',async t=>{
 const f=await fixture(t);const output=path.join(f.source,'data/value');await assert.rejects(()=>createTarGz({source:f.source,output}),/output.*source|source.*output/i);assert.equal(await fsp.readFile(output,'utf8'),'BACKUP_VALUE');
});
// Independent minimal ustar fixture builder, used to challenge the reader.
function header(name,type='0',data=Buffer.alloc(0)){
 const b=Buffer.alloc(512);Buffer.from(name).copy(b,0,0,100);for(const [o,n,v] of [[100,8,0o644],[108,8,0],[116,8,0],[124,12,data.length],[136,12,0]])Buffer.from(v.toString(8).padStart(n-1,'0')+'\0').copy(b,o);b[156]=type.charCodeAt(0);Buffer.from('ustar\0').copy(b,257);checksum(b);return b;
}
function checksum(b){b.fill(32,148,156);const sum=b.reduce((a,x)=>a+x,0);Buffer.from(sum.toString(8).padStart(6,'0')+'\0 ').copy(b,148);}
function record(name,type,data){data=Buffer.from(data);return Buffer.concat([header(name,type,data),data,Buffer.alloc((512-data.length%512)%512)]);}
async function raw(f,buf){await fsp.writeFile(f.archive,zlib.gzipSync(buf));}
for(const [label,buf] of [
 ['missing end marker',record('f','0','x')],
 ['nonzero after end marker',Buffer.concat([record('f','0','x'),Buffer.alloc(1024),Buffer.from('hidden')])],
 ['truncated file payload',header('f','0',Buffer.alloc(8192))],
 ['invalid numeric field',(()=>{const b=header('f');Buffer.from('0000000008\0').copy(b,124);checksum(b);return Buffer.concat([b,Buffer.alloc(1024)]);})()],
 ['malformed PAX length',Buffer.concat([record('PaxHeader','x','999 path=x\n'),Buffer.alloc(1024)])],
 ['duplicate effective path',Buffer.concat([record('f','0','x'),record('./f','0','y'),Buffer.alloc(1024)])]
])test(`reader rejects ${label}`,async t=>{const f=await fixture(t);await raw(f,buf);await assert.rejects(()=>extractTarGz(f));});
test('PAX path traversal is rejected after applying extended header',async t=>{
 const f=await fixture(t);let r='path=../outside\n';let n=Buffer.byteLength(r)+3;while(n!==Buffer.byteLength(`${n} ${r}`))n=Buffer.byteLength(`${n} ${r}`);
 await raw(f,Buffer.concat([record('PaxHeader','x',`${n} ${r}`),record('safe','0','bad'),Buffer.alloc(1024)]));await assert.rejects(()=>extractTarGz(f));assert.equal(fs.existsSync(path.join(f.root,'outside')),false);
});

test('invalid UTF-8 source names are rejected rather than renamed with replacement characters',async t=>{
 const f=await fixture(t);const name=Buffer.concat([Buffer.from(f.source+'/'),Buffer.from([0xff,0xfe])]);await fsp.writeFile(name,'bytes');
 try {await assert.rejects(()=>createTarGz({source:f.source,output:f.archive}),/encoding|encoded|UTF/i);}finally{await fsp.unlink(name);}
});
test('source mutation during reading fails instead of emitting a false successful snapshot',async t=>{
 const f=await fixture(t);const open=fsp.open;let triggered=false;
 fsp.open=async function(p,...args){const handle=await open.call(this,p,...args);if(p===path.join(f.source,'data/value')&&!triggered){triggered=true;await fsp.appendFile(p,'changed');}return handle;};
 try{await assert.rejects(()=>createTarGz({source:f.source,output:f.archive}),/source changed/);assert.equal(triggered,true);}finally{fsp.open=open;}
});
test('source new entry during capture is detected, not silently omitted',async t=>{
 const f=await fixture(t);const open=fsp.open;let triggered=false;
 fsp.open=async function(p,...args){const h=await open.call(this,p,...args);if(p===path.join(f.source,'data/value')&&!triggered){triggered=true;await fsp.writeFile(path.join(f.source,'new-file'),'new');}return h;};
 try{await assert.rejects(()=>createTarGz({source:f.source,output:f.archive}),/source changed/);assert.equal(triggered,true);}finally{fsp.open=open;}
});
test('a parent swapped to a symlink between check and directory open cannot redirect merge',async t=>{
 const f=await fixture(t);await createTarGz({source:f.source,output:f.archive});await fsp.mkdir(path.join(f.destination,'data'),{recursive:true});const outside=path.join(f.root,'outside');await fsp.mkdir(outside);await fsp.writeFile(path.join(outside,'value'),'KEEP');await fsp.chmod(outside,0o750);
 const open=fsp.open;let triggered=false;
 fsp.open=async function(p,...args){if(String(p).endsWith('/data')&&!triggered){triggered=true;await fsp.rename(path.join(f.destination,'data'),path.join(f.destination,'parked'));await fsp.symlink(outside,path.join(f.destination,'data'));}return open.call(this,p,...args);};
 try{await assert.rejects(()=>extractTarGz({...f,rejectExisting:false}));assert.equal(triggered,true);assert.equal(await fsp.readFile(path.join(outside,'value'),'utf8'),'KEEP');assert.equal((await fsp.stat(outside)).mode&0o7777,0o750);}finally{fsp.open=open;}
});
test('a leaf swapped to a symlink immediately before atomic rename is not followed',async t=>{
 const f=await fixture(t);await createTarGz({source:f.source,output:f.archive});await fsp.mkdir(path.join(f.destination,'data'),{recursive:true});await fsp.writeFile(path.join(f.destination,'data/value'),'old');const outside=path.join(f.root,'outside');await fsp.writeFile(outside,'KEEP');await fsp.chmod(outside,0o640);
 const rename=fsp.rename;let triggered=false;
 fsp.rename=async function(a,b){if(String(b).endsWith('/value')&&!triggered){triggered=true;await fsp.unlink(path.join(f.destination,'data/value'));await fsp.symlink(outside,path.join(f.destination,'data/value'));}return rename.call(this,a,b);};
 try{await extractTarGz({...f,rejectExisting:false});assert.equal(triggered,true);assert.equal(await fsp.readFile(outside,'utf8'),'KEEP');assert.equal((await fsp.stat(outside)).mode&0o7777,0o640);assert.equal((await fsp.lstat(path.join(f.destination,'data/value'))).isFile(),true);}finally{fsp.rename=rename;}
});
test('safe merge preserves an identical internal symlink',async t=>{
 const f=await fixture(t);await fsp.symlink('data/value',path.join(f.source,'link'));await createTarGz({source:f.source,output:f.archive});await extractTarGz(f);await extractTarGz({...f,rejectExisting:false});assert.equal(await fsp.readlink(path.join(f.destination,'link')),'data/value');
});
test('PAX extension only applies to its next entry',async t=>{
 const f=await fixture(t);const long='x'.repeat(110);let tail=` path=${long}\n`,n=Buffer.byteLength(tail)+1;while(n!==String(n).length+Buffer.byteLength(tail))n=String(n).length+Buffer.byteLength(tail);
 await raw(f,Buffer.concat([record('PaxHeader','x',`${n}${tail}`),record('placeholder','0','long'),record('short','0','short'),Buffer.alloc(1024)]));await extractTarGz(f);assert.equal(await fsp.readFile(path.join(f.destination,long),'utf8'),'long');assert.equal(await fsp.readFile(path.join(f.destination,'short'),'utf8'),'short');
});
test('GNU sparse or unknown PAX attributes are rejected, not interpreted as ordinary files',async t=>{
 const f=await fixture(t);const tail=' GNU.sparse.size=200\n';let n=tail.length+1;while(n!==String(n).length+tail.length)n=String(n).length+tail.length;
 await raw(f,Buffer.concat([record('PaxHeader','x',`${n}${tail}`),record('f','0','x'),Buffer.alloc(1024)]));await assert.rejects(()=>extractTarGz(f),/unsupported PAX/);
});
test('temporary clean room follows the operating system temporary-directory setting',async t=>{
 const f=await fixture(t);const tmp=path.join(f.root,'os-temp');await fsp.mkdir(tmp);const script=`import {createCleanRoom,removeCleanRoom} from ${JSON.stringify(new URL('../src/core/clean-room.mjs',import.meta.url).href)};import fs from 'node:fs'; const p=await createCleanRoom('wr_b_20260922000000_012345abcdef');console.log(p);await removeCleanRoom(p);if(fs.existsSync(p))process.exit(3);`;
 const proc=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,TMPDIR:tmp}});assert.equal(proc.status,0,proc.stderr);assert.equal(path.dirname(proc.stdout.trim()),tmp);assert.equal(fs.existsSync(proc.stdout.trim()),false);
});
test('merge rejects an archived internal link routed through an existing outside link',async t=>{
 const f=await fixture(t);await fsp.symlink('unknown/value',path.join(f.source,'reference'));await createTarGz({source:f.source,output:f.archive});await fsp.mkdir(f.destination);const outside=path.join(f.root,'outside');await fsp.mkdir(outside);await fsp.writeFile(path.join(outside,'value'),'KEEP');await fsp.symlink(outside,path.join(f.destination,'unknown'));
 await assert.rejects(()=>extractTarGz({...f,rejectExisting:false}),/symlink/);assert.equal(await fsp.readFile(path.join(outside,'value'),'utf8'),'KEEP');assert.equal(fs.existsSync(path.join(f.destination,'reference')),false);
});
test('clean-room chmod never follows a concurrently swapped directory symlink',async t=>{
 const {createCleanRoom,removeCleanRoom}=await import('../src/core/clean-room.mjs');const f=await fixture(t);const room=await createCleanRoom('wr_b_20260922000000_012345abcdef');const inside=path.join(room,'inside'),outside=path.join(f.root,'outside');await fsp.mkdir(inside);await fsp.mkdir(outside,{mode:0o500});
 const lstat=fsp.lstat;let swapped=false;
 fsp.lstat=async function(p,...args){const s=await lstat.call(this,p,...args);if(String(p).endsWith('/inside')&&!swapped){swapped=true;await fsp.rename(inside,path.join(room,'parked'));await fsp.symlink(outside,inside);}return s;};
 try{await removeCleanRoom(room).catch(()=>{});assert.equal(swapped,true);assert.equal((await fsp.stat(outside)).mode&0o7777,0o500);}finally{fsp.lstat=lstat;await fsp.rm(room,{recursive:true,force:true});}
});
test('successful clean-room cleanup handles directories with mode 0000 without root',async t=>{
 const {createCleanRoom,removeCleanRoom}=await import('../src/core/clean-room.mjs');const room=await createCleanRoom('wr_b_20260922000000_012345abcdef');const locked=path.join(room,'locked');await fsp.mkdir(locked);await fsp.writeFile(path.join(locked,'data'),'private');await fsp.chmod(locked,0);
 try {await removeCleanRoom(room);assert.equal(fs.existsSync(room),false);}finally{await fsp.chmod(locked,0o700).catch(()=>{});await fsp.rm(room,{recursive:true,force:true});}
});
