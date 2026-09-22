import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {selectSource,selectionInventory,assertInventory} from './selection.mjs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureDir, sha256File } from './util.mjs';
import { entryHeaders, tarEntries, padding } from './tar-format.mjs';
import { TargetTree } from './target-tree.mjs';

function sameFile(a,b) { return ['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]); }
async function* archiveChunks(entries,watched) {
  let index=0;
  for (const entry of entries) {
    for (const h of entryHeaders(entry,index++)) yield h;
    if (entry.type !== '0') continue;
    const input = await fsp.open(entry.absolute,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try {
      if(!sameFile(entry.identity,await input.stat()))throw new Error(`source changed during backup: ${entry.name}`);
      const hash=crypto.createHash('sha256');
      let remaining=entry.size,position=0;
      while(remaining){const buf=Buffer.alloc(Math.min(1024*1024,remaining));const {bytesRead}=await input.read(buf,0,buf.length,position);if(!bytesRead)throw new Error(`source shrank during backup: ${entry.name}`);remaining-=bytesRead;position+=bytesRead;hash.update(buf.subarray(0,bytesRead));yield buf.subarray(0,bytesRead);}
      if(!sameFile(entry.identity,await input.stat()))throw new Error(`source changed during backup: ${entry.name}`);
      entry.sha256=hash.digest('hex');
      if(padding(entry.size))yield Buffer.alloc(padding(entry.size));
    } finally {await input.close();}
  }
  for(const entry of [...entries,...watched]) {
    const current=await fsp.lstat(entry.absolute);
    if(!sameFile(entry.identity,current))throw new Error(`source changed during backup: ${entry.name}`);
  }
  yield Buffer.alloc(1024);
}
export async function createTarGz({ source, output, excludes = [], includes = ['**'], selection = null }) {
  const sourceRoot=await fsp.realpath(source);
  // Disallow in-source output even through an existing symlinked output parent.
  let parent=path.dirname(path.resolve(output)),missing=[];
  while(true){try{parent=path.join(await fsp.realpath(parent),...missing);break;}catch(e){if(e.code!=='ENOENT')throw e;missing.unshift(path.basename(parent));parent=path.dirname(parent);}}
  const actualOutput=path.join(parent,path.basename(output));
  if(actualOutput===sourceRoot || actualOutput.startsWith(sourceRoot+path.sep))throw new Error('backup output must be outside source');
  selection??=await selectSource({source:sourceRoot,includes,excludes});
  if(selection.sourceRoot!==sourceRoot)throw new Error('selection source mismatch');
  const entries=selection.entries;
  await ensureDir(path.dirname(output));
  // Pipeline owns errors from source iteration, compression and destination.
  // Exclusive output creation never truncates a pre-existing alias/inode.
  await pipeline(Readable.from(archiveChunks(entries,selection.watched)),zlib.createGzip({level:9}),fs.createWriteStream(output,{flags:'wx',mode:0o600}));
  const stat=await fsp.stat(output);
  return {output,bytes:stat.size,sha256:await sha256File(output),entries:entries.map(e=>e.name),inventory:selectionInventory(selection)};
}
export async function extractTarGz({ archive, destination, rejectExisting = true, inventory = null }) {
  const tree=await TargetTree.open(destination,rejectExisting);
  // Private random spool, not a predictable file directly in the shared tmpdir.
  let temp,handle;
  try {
    temp=await fsp.mkdtemp(path.join(os.tmpdir(),'workspace-recover-tar-'));
    const spool=path.join(temp,'payload.tar');
    await pipeline(fs.createReadStream(archive),zlib.createGunzip(),fs.createWriteStream(spool,{flags:'wx',mode:0o600}));
    handle=await fsp.open(spool,'r');
    const materialize=async entry=>{
      if(entry.type==='5')await tree.directoryEntry(entry);
      else if(entry.type==='2')await tree.symlinkEntry(entry);
      else await tree.fileEntry(entry,handle);
    };
    if(inventory)await verifyTarInventory(handle,inventory,materialize);
    else for await(const entry of tarEntries(handle))await materialize(entry);
    await tree.finish();
  } catch(error){await tree.finish(true);throw error;}
  finally{if(handle)await handle.close();await tree.close();if(temp)await fsp.rm(temp,{recursive:true,force:true});}
  return destination;
}


/** Verify each effective entry and the final inventory before application workflow. */
export async function verifyTarInventory(handle,inventory,onEntry=null) {
  assertInventory(inventory);const expected=new Map(inventory.entries.map(e=>[e.path,e])),seen=new Set();
  for await(const entry of tarEntries(handle)) {
    const e=expected.get(entry.name),type=({'0':'file','5':'directory','2':'symlink'})[entry.type];
    if(!e||seen.has(entry.name)||e.type!==type||e.mode!==entry.mode)throw new Error(`inventory metadata mismatch: ${entry.name}`);
    seen.add(entry.name);
    if(type==='symlink'&&e.target!==entry.linkname)throw new Error(`inventory symlink mismatch: ${entry.name}`);
    if(type==='file') {
      if(e.bytes!==entry.size)throw new Error(`inventory size mismatch: ${entry.name}`);
      const hash=crypto.createHash('sha256');let position=entry.offset,remaining=entry.size;
      const buffer=Buffer.alloc(Math.min(1024*1024,Math.max(1,remaining)));
      while(remaining){const {bytesRead}=await handle.read(buffer,0,Math.min(remaining,buffer.length),position);if(!bytesRead)throw new Error('truncated inventory data');hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;remaining-=bytesRead;}
      if(hash.digest('hex')!==e.sha256)throw new Error(`inventory hash mismatch: ${entry.name}`);
    }
    if(onEntry)await onEntry(entry);
  }
  if(seen.size!==expected.size)throw new Error('inventory has missing archive entries');
  return {entries:seen.size,verified:true};
}

export async function splitFile({ file, outputDirectory, maxPartBytes = 64 * 1024 * 1024 }) {
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes < 1) throw new Error('maxPartBytes must be a positive integer');
  await ensureDir(outputDirectory);
  const handle = await fsp.open(file, 'r');
  const parts = [];
  try {
    const stat = await handle.stat();
    let position = 0;
    let index = 0;
    while (position < stat.size) {
      const bytes = Math.min(maxPartBytes, stat.size - position);
      const name = `${path.basename(file)}.part-${String(index).padStart(3, '0')}`;
      const outPath = path.join(outputDirectory, name);
      const out = await fsp.open(outPath, 'w', 0o600);
      try {
        let remaining = bytes;
        const buffer = Buffer.alloc(Math.min(1024 * 1024, bytes));
        while (remaining > 0) {
          const length = Math.min(buffer.length, remaining);
          const read = await handle.read(buffer, 0, length, position);
          if (read.bytesRead <= 0) throw new Error('unexpected EOF while splitting archive');
          let written = 0;
          while (written < read.bytesRead) {
            const part = await out.write(buffer, written, read.bytesRead-written, null);
            if (!part.bytesWritten) throw new Error('zero-byte write while splitting');
            written += part.bytesWritten;
          }
          position += read.bytesRead;
          remaining -= read.bytesRead;
        }
      } finally {
        await out.close();
      }
      parts.push({ index, fileName: name, path: outPath, bytes, sha256: await sha256File(outPath) });
      index += 1;
    }
  } finally {
    await handle.close();
  }
  return parts;
}

export async function assembleParts({ parts, output }) {
  await ensureDir(path.dirname(output));
  async function* verifiedChunks() {
    for (const part of [...parts].sort((a,b)=>a.index-b.index)) {
      if(path.resolve(part.path)===path.resolve(output))throw new Error('assembled archive must not overwrite an input part');
      const stat=await fsp.stat(part.path);
      if(part.bytes!==undefined && stat.size!==part.bytes)throw new Error(`part size mismatch: ${part.fileName}`);
      if(part.sha256 && await sha256File(part.path)!==part.sha256)throw new Error(`part sha256 mismatch: ${part.fileName}`);
      yield* fs.createReadStream(part.path);
    }
  }
  const spool=await fsp.mkdtemp(path.join(path.dirname(output),'.wr-assembly-'));
  try {
    const candidate=path.join(spool,'archive');
    await pipeline(Readable.from(verifiedChunks()),fs.createWriteStream(candidate,{flags:'wx',mode:0o600}));
    await fsp.rename(candidate,output);
  } finally {await fsp.rm(spool,{recursive:true,force:true});}
  const stat=await fsp.stat(output);return {output,bytes:stat.size,sha256:await sha256File(output)};
}
