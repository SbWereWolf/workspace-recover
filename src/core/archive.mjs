import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureDir, sha256File } from './util.mjs';
import { entryHeaders, tarEntries, padding } from './tar-format.mjs';
import { TargetTree } from './target-tree.mjs';

function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function excluded(relative, patterns) {
  return patterns.some(pattern => globToRegex(pattern.replace(/^\.\//, '')).test(relative));
}

async function walk(root, excludes) {
  const entries = [];
  async function visit(absolute, relative) {
    if (relative && excluded(relative, excludes)) return;
    const stat = await fsp.lstat(absolute);
    const identity = {dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
    const posix = relative.split(path.sep).join('/');
    if (stat.isDirectory()) {
      entries.push({ identity, absolute, name: relative ? `${posix}/` : './', type: '5', mode: stat.mode, size: 0, mtimeMs: stat.mtimeMs });
      const decoder = new TextDecoder('utf-8', {fatal:true});
      const names = (await fsp.readdir(absolute, {encoding:'buffer'})).map(b=>decoder.decode(b)).sort();
      for (const name of names) await visit(path.join(absolute, name), relative ? path.join(relative, name) : name);
    } else if (stat.isFile()) {
      entries.push({ identity, absolute, name: posix, type: '0', mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs });
    } else if (stat.isSymbolicLink()) {
      const linkname = await fsp.readlink(absolute);
      entries.push({ identity, absolute, name: posix, type: '2', mode: stat.mode, size: 0, mtimeMs: stat.mtimeMs, linkname });
    } else {
      throw new Error(`unsupported filesystem entry: ${absolute}`);
    }
  }
  await visit(root, '');
  return entries;
}


function sameFile(a,b) { return ['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]); }
async function* archiveChunks(entries) {
  let index=0;
  for (const entry of entries) {
    for (const h of entryHeaders(entry,index++)) yield h;
    if (entry.type !== '0') continue;
    const input = await fsp.open(entry.absolute,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try {
      if(!sameFile(entry.identity,await input.stat()))throw new Error(`source changed during backup: ${entry.name}`);
      let remaining=entry.size,position=0;
      while(remaining){const buf=Buffer.alloc(Math.min(1024*1024,remaining));const {bytesRead}=await input.read(buf,0,buf.length,position);if(!bytesRead)throw new Error(`source shrank during backup: ${entry.name}`);remaining-=bytesRead;position+=bytesRead;yield buf.subarray(0,bytesRead);}
      if(!sameFile(entry.identity,await input.stat()))throw new Error(`source changed during backup: ${entry.name}`);
      if(padding(entry.size))yield Buffer.alloc(padding(entry.size));
    } finally {await input.close();}
  }
  for(const entry of entries) {
    const current=await fsp.lstat(entry.absolute);
    if(!sameFile(entry.identity,current))throw new Error(`source changed during backup: ${entry.name}`);
  }
  yield Buffer.alloc(1024);
}
export async function createTarGz({ source, output, excludes = [] }) {
  const sourceRoot=await fsp.realpath(source);
  // Disallow in-source output even through an existing symlinked output parent.
  let parent=path.dirname(path.resolve(output)),missing=[];
  while(true){try{parent=path.join(await fsp.realpath(parent),...missing);break;}catch(e){if(e.code!=='ENOENT')throw e;missing.unshift(path.basename(parent));parent=path.dirname(parent);}}
  const actualOutput=path.join(parent,path.basename(output));
  if(actualOutput===sourceRoot || actualOutput.startsWith(sourceRoot+path.sep))throw new Error('backup output must be outside source');
  const entries=await walk(sourceRoot,excludes);
  await ensureDir(path.dirname(output));
  // Pipeline owns errors from source iteration, compression and destination.
  // Exclusive output creation never truncates a pre-existing alias/inode.
  await pipeline(Readable.from(archiveChunks(entries)),zlib.createGzip({level:9}),fs.createWriteStream(output,{flags:'wx',mode:0o600}));
  const stat=await fsp.stat(output);
  return {output,bytes:stat.size,sha256:await sha256File(output),entries:entries.map(e=>e.name)};
}
export async function extractTarGz({ archive, destination, rejectExisting = true }) {
  const tree=await TargetTree.open(destination,rejectExisting);
  // Private random spool, not a predictable file directly in the shared tmpdir.
  let temp,handle;
  try {
    temp=await fsp.mkdtemp(path.join(os.tmpdir(),'workspace-recover-tar-'));
    const spool=path.join(temp,'payload.tar');
    await pipeline(fs.createReadStream(archive),zlib.createGunzip(),fs.createWriteStream(spool,{flags:'wx',mode:0o600}));
    handle=await fsp.open(spool,'r');
    for await(const entry of tarEntries(handle)) {
      if(entry.type==='5')await tree.directoryEntry(entry);
      else if(entry.type==='2')await tree.symlinkEntry(entry);
      else await tree.fileEntry(entry,handle);
    }
    await tree.finish();
  } catch(error){await tree.finish(true);throw error;}
  finally{if(handle)await handle.close();await tree.close();if(temp)await fsp.rm(temp,{recursive:true,force:true});}
  return destination;
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
