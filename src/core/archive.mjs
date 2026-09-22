import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { ensureDir, pathExists, sha256File } from './util.mjs';

function octal(value, length) {
  const text = Math.max(0, value).toString(8).padStart(length - 1, '0');
  return Buffer.from(`${text}\0`);
}

function writeField(header, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  bytes.copy(header, offset);
}

function splitTarPath(name) {
  const bytes = Buffer.byteLength(name);
  if (bytes <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    const leaf = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(leaf) <= 100) return { name: leaf, prefix };
  }
  throw new Error(`path too long for ustar: ${name}`);
}

function tarHeader(entry) {
  const header = Buffer.alloc(512, 0);
  const split = splitTarPath(entry.name);
  writeField(header, 0, 100, split.name);
  octal(entry.mode & 0o7777, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(entry.size, 12).copy(header, 124);
  octal(Math.floor(entry.mtimeMs / 1000), 12).copy(header, 136);
  Buffer.from('        ').copy(header, 148);
  writeField(header, 156, 1, entry.type);
  if (entry.linkname) writeField(header, 157, 100, entry.linkname);
  writeField(header, 257, 6, 'ustar\0');
  writeField(header, 263, 2, '00');
  writeField(header, 265, 32, 'workspace-recover');
  writeField(header, 297, 32, 'workspace-recover');
  if (split.prefix) writeField(header, 345, 155, split.prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = sum.toString(8).padStart(6, '0');
  Buffer.from(`${checksum}\0 `).copy(header, 148);
  return header;
}

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
    const posix = relative.split(path.sep).join('/');
    if (stat.isDirectory()) {
      entries.push({ absolute, name: relative ? `${posix}/` : './', type: '5', mode: stat.mode, size: 0, mtimeMs: stat.mtimeMs });
      const names = (await fsp.readdir(absolute)).sort();
      for (const name of names) await visit(path.join(absolute, name), relative ? path.join(relative, name) : name);
    } else if (stat.isFile()) {
      entries.push({ absolute, name: posix, type: '0', mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs });
    } else if (stat.isSymbolicLink()) {
      const linkname = await fsp.readlink(absolute);
      entries.push({ absolute, name: posix, type: '2', mode: stat.mode, size: 0, mtimeMs: stat.mtimeMs, linkname });
    } else {
      throw new Error(`unsupported filesystem entry: ${absolute}`);
    }
  }
  await visit(root, '');
  return entries;
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await new Promise(resolve => stream.once('drain', resolve));
}

export async function createTarGz({ source, output, excludes = [] }) {
  const sourceRoot = path.resolve(source);
  const entries = await walk(sourceRoot, excludes);
  await ensureDir(path.dirname(output));
  const gzip = zlib.createGzip({ level: 9 });
  const sink = fs.createWriteStream(output, { mode: 0o600 });
  const pipePromise = pipeline(gzip, sink);
  for (const entry of entries) {
    await writeChunk(gzip, tarHeader(entry));
    if (entry.type === '0') {
      for await (const chunk of fs.createReadStream(entry.absolute)) await writeChunk(gzip, chunk);
      const padding = (512 - (entry.size % 512)) % 512;
      if (padding) await writeChunk(gzip, Buffer.alloc(padding));
    }
  }
  await writeChunk(gzip, Buffer.alloc(1024));
  gzip.end();
  await pipePromise;
  const stat = await fsp.stat(output);
  return { output, bytes: stat.size, sha256: await sha256File(output), entries: entries.map(e => e.name) };
}

function parseString(buffer, start, length) {
  return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}

function parseOctal(buffer, start, length) {
  const text = parseString(buffer, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function safeTarget(root, name) {
  if (!name || name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) throw new Error(`unsafe archive path: ${name}`);
  const normalized = path.posix.normalize(name);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`unsafe archive path: ${name}`);
  const target = path.resolve(root, ...normalized.split('/'));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error(`archive path escapes target: ${name}`);
  return target;
}

export async function extractTarGz({ archive, destination, rejectExisting = true }) {
  if (rejectExisting && await pathExists(destination)) throw new Error(`restore target already exists: ${destination}`);
  await ensureDir(destination);
  const tempTar = path.join(os.tmpdir(), `workspace-recover-${process.pid}-${Date.now()}.tar`);
  const directoryModes = new Map();
  const applyDirectoryModes = async ({ bestEffort = false } = {}) => {
    if (process.platform === 'win32') return;
    const ordered = [...directoryModes.entries()].sort(([a], [b]) => b.split(path.sep).length - a.split(path.sep).length);
    for (const [target, mode] of ordered) {
      try {
        await fsp.chmod(target, mode);
      } catch (error) {
        if (!bestEffort) throw error;
      }
    }
  };
  try {
    await pipeline(fs.createReadStream(archive), zlib.createGunzip(), fs.createWriteStream(tempTar, { mode: 0o600 }));
    const handle = await fsp.open(tempTar, 'r');
    try {
      let offset = 0;
      const header = Buffer.alloc(512);
      while (true) {
        const read = await handle.read(header, 0, 512, offset);
        if (read.bytesRead === 0) break;
        if (read.bytesRead !== 512) throw new Error('truncated tar header');
        offset += 512;
        if (header.every(byte => byte === 0)) break;
        const storedChecksum = parseOctal(header, 148, 8);
        const checksumHeader = Buffer.from(header);
        Buffer.from('        ').copy(checksumHeader, 148);
        let computedChecksum = 0;
        for (const byte of checksumHeader) computedChecksum += byte;
        if (storedChecksum !== computedChecksum) throw new Error('invalid tar header checksum');
        const name = parseString(header, 0, 100);
        const prefix = parseString(header, 345, 155);
        const fullName = prefix ? `${prefix}/${name}` : name;
        const type = parseString(header, 156, 1) || '0';
        const size = parseOctal(header, 124, 12);
        const mode = parseOctal(header, 100, 8) & 0o7777;
        const target = safeTarget(destination, fullName.replace(/\/$/, ''));
        if (type === '5') {
          await ensureDir(target);
          directoryModes.set(target, mode);
          // Keep directories owner-writable/searchable while extracting children.
          // Final source modes are applied deepest-first after the whole archive is materialized.
          if (process.platform !== 'win32') await fsp.chmod(target, mode | 0o700);
        } else if (type === '2') {
          const linkname = parseString(header, 157, 100);
          if (!linkname || path.isAbsolute(linkname)) throw new Error(`unsafe symlink target for ${fullName}: ${linkname}`);
          const resolved = path.resolve(path.dirname(target), linkname);
          const base = path.resolve(destination);
          if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error(`symlink escapes target: ${fullName} -> ${linkname}`);
          await ensureDir(path.dirname(target));
          await fsp.symlink(linkname, target);
        } else if (type === '0' || type === '\0') {
          await ensureDir(path.dirname(target));
          const out = await fsp.open(target, 'w', mode);
          try {
            let remaining = size;
            let position = offset;
            const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, size)));
            while (remaining > 0) {
              const length = Math.min(buffer.length, remaining);
              const part = await handle.read(buffer, 0, length, position);
              if (part.bytesRead <= 0) throw new Error(`truncated file data: ${fullName}`);
              await out.write(buffer, 0, part.bytesRead, null);
              position += part.bytesRead;
              remaining -= part.bytesRead;
            }
          } finally {
            await out.close();
          }
          if (process.platform !== 'win32') await fsp.chmod(target, mode);
        } else {
          throw new Error(`unsupported tar entry type ${type} for ${fullName}`);
        }
        const padded = Math.ceil(size / 512) * 512;
        offset += padded;
      }
    } finally {
      await handle.close();
    }
    await applyDirectoryModes();
  } catch (error) {
    // Preserve partial evidence and best-effort restore every directory mode already observed.
    // Never erase or silently relax a workspace because extraction failed.
    await applyDirectoryModes({ bestEffort: true });
    throw error;
  } finally {
    await fsp.rm(tempTar, { force: true });
  }
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
          await out.write(buffer, 0, read.bytesRead, null);
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
  const sink = fs.createWriteStream(output, { mode: 0o600 });
  try {
    for (const part of [...parts].sort((a, b) => a.index - b.index)) {
      const stat = await fsp.stat(part.path);
      if (part.bytes !== undefined && stat.size !== part.bytes) throw new Error(`part size mismatch: ${part.fileName}`);
      if (part.sha256 && await sha256File(part.path) !== part.sha256) throw new Error(`part sha256 mismatch: ${part.fileName}`);
      for await (const chunk of fs.createReadStream(part.path)) await writeChunk(sink, chunk);
    }
  } finally {
    sink.end();
    await new Promise((resolve, reject) => { sink.on('close', resolve); sink.on('error', reject); });
  }
  const stat = await fsp.stat(output);
  return { output, bytes: stat.size, sha256: await sha256File(output) };
}
