/** Strict POSIX ustar/PAX transport. PAX record lengths count UTF-8 bytes. */
import path from 'node:path';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const OCTAL_MAX = 0o77777777777;
const MAX_PAX_BYTES = 1024 * 1024;
export const padding = size => (512 - size % 512) % 512;
export function archiveName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)
      || name.split('/').includes('..') || (path.sep === '\\' && name.includes('\\'))) throw new Error(`unsafe archive path: ${name}`);
  return path.posix.normalize(name).replace(/\/$/, '') || '.';
}
function split(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  for (let i = name.indexOf('/'); i >= 0; i = name.indexOf('/', i + 1)) {
    if (i && Buffer.byteLength(name.slice(0, i)) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100) return { prefix: name.slice(0, i), name: name.slice(i + 1) };
  }
  return null;
}
function octal(value, length) {
  if (!Number.isSafeInteger(value) || value < 0 || value.toString(8).length > length - 1) throw new Error('tar numeric value out of range');
  return Buffer.from(value.toString(8).padStart(length - 1, '0') + '\0');
}
function field(b, offset, length, text) {
  const bytes = Buffer.from(text);
  if (bytes.length > length || text.includes('\0')) throw new Error('invalid tar text field');
  bytes.copy(b, offset);
}
function header(entry) {
  const b = Buffer.alloc(512); const p = split(entry.name);
  if (!p) throw new Error('internal tar placeholder too long');
  field(b, 0, 100, p.name); field(b, 345, 155, p.prefix);
  for (const [offset, length, value] of [[100, 8, entry.mode & 0o7777], [108, 8, 0], [116, 8, 0], [124, 12, entry.size], [136, 12, entry.mtime]]) octal(value, length).copy(b, offset);
  b.fill(32, 148, 156); field(b, 156, 1, entry.type); field(b, 157, 100, entry.linkname || '');
  field(b, 257, 6, 'ustar'); field(b, 263, 2, '00'); field(b, 265, 32, 'workspace-recover'); field(b, 297, 32, 'workspace-recover');
  Buffer.from(b.reduce((sum, x) => sum + x, 0).toString(8).padStart(6, '0') + '\0 ').copy(b, 148);
  return b;
}
function paxRecord(key, value) {
  const tail = ` ${key}=${value}\n`;
  let size = Buffer.byteLength(tail) + 1;
  while (size !== String(size).length + Buffer.byteLength(tail)) size = String(size).length + Buffer.byteLength(tail);
  return Buffer.from(`${size}${tail}`);
}
export function entryHeaders(entry, index) {
  archiveName(entry.name);
  const attrs = {};
  const short = { ...entry, mtime: Math.max(0, Math.floor(entry.mtimeMs / 1000)) };
  if (!split(entry.name) || /[^\x00-\x7f]/.test(entry.name)) { attrs.path = entry.name; short.name = `PaxEntry/${index}`; }
  if (entry.linkname && (Buffer.byteLength(entry.linkname) > 100 || /[^\x00-\x7f]/.test(entry.linkname))) { attrs.linkpath = entry.linkname; short.linkname = ''; }
  if (entry.size > OCTAL_MAX) { attrs.size = String(entry.size); short.size = 0; }
  if (entry.mtimeMs < 0 || short.mtime > OCTAL_MAX) { attrs.mtime = String(entry.mtimeMs / 1000); short.mtime = 0; }
  const chunks = [];
  if (Object.keys(attrs).length) {
    const body = Buffer.concat(Object.entries(attrs).map(([key, value]) => paxRecord(key, value)));
    if (body.length > MAX_PAX_BYTES) throw new Error('PAX metadata exceeds 1 MiB limit');
    chunks.push(header({name:`PaxHeaders/${index}`,type:'x',mode:0o600,size:body.length,mtime:0}), body, Buffer.alloc(padding(body.length)));
  }
  chunks.push(header(short)); return chunks;
}
function text(b, start, length) {
  const raw = b.subarray(start, start + length); const end = raw.indexOf(0);
  return utf8.decode(end < 0 ? raw : raw.subarray(0, end));
}
function number(b, start, length) {
  const raw = text(b, start, length).trim();
  if (!/^[0-7]*$/.test(raw)) throw new Error('invalid tar numeric field');
  const value = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(value)) throw new Error('tar numeric field out of range');
  return value;
}
async function exactRead(handle, length, position) {
  const result = Buffer.alloc(length); let done = 0;
  while (done < length) { const { bytesRead } = await handle.read(result, done, length - done, position + done); if (!bytesRead) throw new Error('truncated tar data'); done += bytesRead; }
  return result;
}
function pax(body) {
  const result = Object.create(null); let offset = 0;
  const allowed = new Set(['path','linkpath','size','mtime','uid','gid','uname','gname','atime','ctime','comment','charset']);
  while (offset < body.length) {
    const space = body.indexOf(32, offset);
    const rawLength = space < 0 ? '' : body.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(rawLength)) throw new Error('invalid PAX record length');
    const length = Number(rawLength), end = offset + length;
    if (!Number.isSafeInteger(length) || end > body.length || end <= space + 2 || body[end - 1] !== 10) throw new Error('invalid PAX record boundary');
    const eq = body.indexOf(61, space + 1);
    if (eq < space + 2 || eq >= end - 1) throw new Error('invalid PAX keyword');
    const key = utf8.decode(body.subarray(space + 1, eq)); const value = utf8.decode(body.subarray(eq + 1, end - 1));
    if (!allowed.has(key)) throw new Error(`unsupported PAX keyword: ${key}`);
    if (value.includes('\0')) throw new Error('NUL in PAX record');
    result[key] = value; offset = end;
  }
  return result;
}
/** Stream entry metadata only; file contents remain on the verified private spool. */
export async function* tarEntries(handle) {
  const total = (await handle.stat()).size; let offset = 0; let local = null; let global = {};
  const seen = new Set();
  while (true) {
    if (offset + 512 > total) throw new Error('missing or truncated tar end marker');
    const b = await exactRead(handle, 512, offset); offset += 512;
    if (b.every(x => x === 0)) {
      if (local) throw new Error('orphan PAX header');
      if (offset + 512 > total) throw new Error('missing second tar end marker');
      if (total % 512) throw new Error('invalid tar trailing size');
      while (offset < total) { const buf = await exactRead(handle, Math.min(1024*1024, total-offset), offset); if (buf.some(x=>x!==0)) throw new Error('nonzero data after tar end marker'); offset += buf.length; }
      return;
    }
    const stored = number(b, 148, 8); const check = Buffer.from(b); check.fill(32, 148, 156);
    if (stored !== check.reduce((sum,x)=>sum+x,0)) throw new Error('invalid tar header checksum');
    if (text(b,257,6) !== 'ustar') throw new Error('unsupported tar header format');
    const type = text(b,156,1) || '0'; const rawSize = number(b,124,12); const mode = number(b,100,8);
    if (mode > 0o7777) throw new Error('invalid tar mode');
    // PAX may override a legacy field truncated mid UTF-8 sequence. Decode only the effective name.
    const rawName = () => {const prefix=text(b,345,155);return `${prefix ? prefix+'/' : ''}${text(b,0,100)}`;};
    if (type === 'x' || type === 'g') {
      if (rawSize > MAX_PAX_BYTES) throw new Error('PAX metadata exceeds 1 MiB limit');
      if (offset + rawSize + padding(rawSize) > total) throw new Error('truncated PAX data');
      const attrs = pax(await exactRead(handle,rawSize,offset));
      if (type === 'x') local = {...local,...attrs}; else { for(const [k,v] of Object.entries(attrs)){if(v==='')delete global[k];else global[k]=v;} }
      offset += rawSize + padding(rawSize); continue;
    }
    if (!['0','2','5'].includes(type)) throw new Error(`unsupported tar entry type ${type}`);
    const attrs = {...global,...local}; local = null;
    const fullName = attrs.path || rawName(); const name = archiveName(fullName);
    const linkname = attrs.linkpath || text(b,157,100);
    let size = rawSize;
    if (attrs.size !== undefined) { if(!/^[0-9]+$/.test(attrs.size))throw new Error('invalid PAX size');size=Number(attrs.size); }
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset+size+padding(size))) throw new Error('invalid tar entry size');
    if (type !== '0' && size !== 0) throw new Error('non-file tar entry has payload');
    if (offset + size + padding(size) > total) throw new Error(`truncated file data: ${fullName}`);
    if (name === '.' && type !== '5') throw new Error('archive root must be a directory');
    if (seen.has(name)) throw new Error(`duplicate archive path: ${name}`); seen.add(name);
    // '..' may be legitimate in a relative symlink; validate its resolved endpoint.
    if (type === '2' && (!linkname || linkname.includes('\0') || path.posix.isAbsolute(linkname) || /^[A-Za-z]:/.test(linkname)
        || (path.sep==='\\' && linkname.includes('\\')) || path.posix.normalize(path.posix.join(path.posix.dirname(name),linkname)).match(/^(\.\.(\/|$)|\/)/))) throw new Error(`symlink escapes target or is unsafe: ${name} -> ${linkname}`);
    yield {name,fullName,type,size,mode,linkname,offset}; offset += size + padding(size);
  }
}
