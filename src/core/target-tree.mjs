import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { archiveName } from './tar-format.mjs';

const C = fs.constants;
const FLAGS = C.O_RDONLY | (C.O_DIRECTORY || 0) | (C.O_NOFOLLOW || 0);
async function lstat(p) { try { return await fsp.lstat(p); } catch (e) { if(e.code==='ENOENT')return null;throw e; } }
function child(directory, name) { return path.join(process.platform==='linux' ? `/proc/self/fd/${directory.fd}` : directory.path, name); }
async function openDirectory(p, expectedPath) {
  const stat=await lstat(p);
  if(!stat?.isDirectory() || stat.isSymbolicLink())throw new Error(`unsafe restore directory or symlink: ${expectedPath}`);
  const handle=await fsp.open(p,FLAGS);
  const opened=await handle.stat();
  if(!opened.isDirectory() || stat.dev!==opened.dev || stat.ino!==opened.ino){await handle.close();throw new Error(`restore directory changed: ${expectedPath}`);}
  return {fd:handle.fd,handle,path:expectedPath};
}
async function validateDirectory(directory) {
  const stat=await lstat(directory.path);const held=await directory.handle.stat();
  if(!stat?.isDirectory() || stat.isSymbolicLink() || stat.dev!==held.dev || stat.ino!==held.ino
      || await fsp.realpath(directory.path)!==directory.path
      || (process.platform==='linux' && await fsp.realpath(`/proc/self/fd/${directory.fd}`)!==directory.path))throw new Error(`restore directory changed or became a symlink: ${directory.path}`);
}

/**
 * Filesystem boundary shared by all materialized entries.
 * Linux operations are anchored to open directory descriptors via procfs, not
 * re-resolved user path strings. Leaf writes are exclusive new files + rename;
 * never O_TRUNC on an existing (possibly hardlinked) inode.
 * The operator must keep destination ancestors exclusively owned during restore;
 * this is not a sandbox against a hostile process that can move open directories.
 */
export class TargetTree {
  constructor(root, directory) { this.root=root;this.directory=directory;this.modes=new Map(); }
  static async open(destination, rejectExisting) {
    const root=path.resolve(destination); const existing=await lstat(root);
    if(rejectExisting && existing)throw new Error(`restore target already exists: ${root}`);
    if(root===path.parse(root).root)throw new Error('refusing filesystem root as restore target');
    const parts=root.slice(path.parse(root).root.length).split(path.sep).filter(Boolean);
    let directory=await openDirectory(path.parse(root).root,path.parse(root).root);
    try {
      for(let i=0;i<parts.length;i++) {
        await validateDirectory(directory);
        const p=child(directory,parts[i]), expected=path.join(directory.path,parts[i]);
        let stat=await lstat(p);
        if(!stat){try{await fsp.mkdir(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}stat=await lstat(p);}
        else if(i===parts.length-1 && rejectExisting)throw new Error(`restore target already exists: ${root}`);
        const next=await openDirectory(p,expected);await directory.handle.close();directory=next;
      }
      return new TargetTree(root,directory);
    } catch(error){await directory.handle.close();throw error;}
  }
  async directoryFor(name, create=true) {
    const normalized=archiveName(name);let current=this.directory;const handles=[];
    try {
      await validateDirectory(current);
      if(normalized!=='.')for(const part of normalized.split('/')) {
        await validateDirectory(current);
        const p=child(current,part), expected=path.join(current.path,part);
        if(!(await lstat(p)) && create){try{await fsp.mkdir(p,{mode:0o700});this.modes.set(path.relative(this.root,expected),0o755);}catch(e){if(e.code!=='EEXIST')throw e;}}
        const next=await openDirectory(p,expected);handles.push(next.handle);current=next;
      }
      return { ...current, close:async()=>{for(const h of handles.reverse())await h.close();} };
    } catch(error){for(const h of handles.reverse())await h.close();throw error;}
  }
  async directoryEntry(entry) {
    const d=await this.directoryFor(entry.name);
    try {await validateDirectory(d);this.modes.set(entry.name,entry.mode);if(process.platform!=='win32')await d.handle.chmod(entry.mode|0o700);}
    finally {await d.close();}
  }
  async fileEntry(entry, tar) {
    const d=await this.directoryFor(path.posix.dirname(entry.name));
    let out=null, temp=null;
    try {
      await validateDirectory(d);const leaf=path.posix.basename(entry.name);const dest=child(d,leaf);
      const initial=await lstat(dest);
      if(initial && (!initial.isFile() || initial.isSymbolicLink()))throw new Error(`unsafe existing restore file or symlink: ${entry.name}`);
      temp=child(d,`.wr-extract-${crypto.randomBytes(16).toString('hex')}`);
      out=await fsp.open(temp,C.O_WRONLY|C.O_CREAT|C.O_EXCL|(C.O_NOFOLLOW||0),0o600);
      let remaining=entry.size,position=entry.offset;const buffer=Buffer.alloc(Math.min(1024*1024,Math.max(1,remaining)));
      while(remaining){const {bytesRead}=await tar.read(buffer,0,Math.min(buffer.length,remaining),position);if(!bytesRead)throw new Error(`truncated file data: ${entry.name}`);
        let wrote=0;while(wrote<bytesRead){const {bytesWritten}=await out.write(buffer,wrote,bytesRead-wrote,null);if(!bytesWritten)throw new Error('zero-byte write');wrote+=bytesWritten;}
        remaining-=bytesRead;position+=bytesRead;
      }
      if(process.platform!=='win32')await out.chmod(entry.mode);
      await out.close();out=null;
      await validateDirectory(d);
      const current=await lstat(dest);
      if(current && (!current.isFile() || current.isSymbolicLink()))throw new Error(`unsafe existing restore file or symlink: ${entry.name}`);
      // Even a link introduced after the last lstat is replaced, never followed.
      await fsp.rename(temp,dest);temp=null;
    } catch(error) {
      // Partial new bytes remain available for diagnosis, not silently removed.
      if(temp)error.message+=` (partial entry: ${path.join(d.path,path.basename(temp))})`;
      throw error;
    } finally {if(out)await out.close();await d.close();}
  }
  async symlinkEntry(entry) {
    const d=await this.directoryFor(path.posix.dirname(entry.name));
    try {
      await validateDirectory(d);const dest=child(d,path.posix.basename(entry.name));
      // Idempotent safe merge of an identical internal link. Never chmod/dereference it.
      const present=await lstat(dest);
      if(present && (!present.isSymbolicLink() || await fsp.readlink(dest)!==entry.linkname))throw new Error(`existing entry conflicts with archive symlink: ${entry.name}`);
      // The link's endpoint is validated lexically by the TAR parser. Existing
      // endpoint ancestors must not resolve indirectly through an outside link.
      const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(entry.name),entry.linkname));
      await this.checkLinkEndpoint(resolved,new Set([entry.name]));
      if(present)return;
      await fsp.symlink(entry.linkname,dest);
    } finally {await d.close();}
  }
  async checkLinkEndpoint(name,seen) {
    archiveName(name); const parts=name==='.'?[]:name.split('/'); let prefix='';
    for(let i=0;i<parts.length;i++) {
      const d=await this.directoryFor(prefix||'.',false);
      try {await validateDirectory(d);const p=child(d,parts[i]);const s=await lstat(p);if(!s)return;
        if(s.isSymbolicLink()){
          const link=await fsp.readlink(p);const next=path.posix.normalize(path.posix.join(prefix,link,...parts.slice(i+1)));
          if(path.isAbsolute(link) || /^[A-Za-z]:/.test(link) || seen.has(next) || seen.size>40)throw new Error(`unsafe or cyclic symlink endpoint: ${name}`);
          archiveName(next);seen.add(next);return this.checkLinkEndpoint(next,seen);
        }
        if(i<parts.length-1 && !s.isDirectory())throw new Error(`symlink endpoint is not a directory: ${name}`);
      } finally {await d.close();}
      prefix=prefix?`${prefix}/${parts[i]}`:parts[i];
    }
  }
  async finish(bestEffort=false) {
    for(const [name,mode] of [...this.modes].sort(([a],[b])=>(b==='.'?0:b.split('/').length)-(a==='.'?0:a.split('/').length))) {
      let d;
      try{d=await this.directoryFor(name,false);await validateDirectory(d);if(process.platform!=='win32')await d.handle.chmod(mode);}catch(error){if(!bestEffort)throw error;}finally{if(d)await d.close();}
    }
  }
  async close(){await this.directory.handle.close();}
}
