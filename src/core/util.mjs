import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'workspace-recover';

export function homeConfigDir() {
  return process.env.WORKSPACE_RECOVER_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME);
}

export function homeStateDir() {
  return process.env.WORKSPACE_RECOVER_STATE_DIR ||
    path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), APP_NAME);
}

export function homeCacheDir() {
  return process.env.WORKSPACE_RECOVER_CACHE_DIR ||
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), APP_NAME);
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function pathExists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

export async function writeJsonAtomic(file, value, mode = 0o600) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fsp.rename(temp, file);
  await fsp.chmod(file, mode);
}

export async function writeTextAtomic(file, value, mode = 0o600) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temp, value, { mode });
  await fsp.rename(temp, file);
  await fsp.chmod(file, mode);
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sessionId(prefix = 'wr') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}_${stamp}_${crypto.randomBytes(6).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function parseScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export function parseSet(items = []) {
  const result = {};
  for (const item of items) {
    const at = item.indexOf('=');
    if (at < 1) throw new Error(`--set requires key=value, got ${item}`);
    setByPath(result, item.slice(0, at), parseScalar(item.slice(at + 1)));
  }
  return result;
}

export function getByPath(object, dotted) {
  return dotted.split('.').reduce((value, key) => value?.[key], object);
}

export function setByPath(object, dotted, value) {
  const parts = dotted.split('.');
  let cursor = object;
  for (const key of parts.slice(0, -1)) {
    cursor[key] ??= {};
    cursor = cursor[key];
  }
  cursor[parts.at(-1)] = value;
}

export function deepMerge(base, overlay) {
  if (Array.isArray(base) || Array.isArray(overlay) || typeof base !== 'object' || base === null || typeof overlay !== 'object' || overlay === null) {
    return structuredClone(overlay);
  }
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = key in result ? deepMerge(result[key], value) : structuredClone(value);
  }
  return result;
}

export function encodeBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64Url(value = '') {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64');
}

export async function chmodPrivate(file) {
  if (process.platform !== 'win32') await fsp.chmod(file, 0o600);
}

export async function copyFileVerified(source, destination) {
  await ensureDir(path.dirname(destination));
  await fsp.copyFile(source, destination);
  const [a, b] = await Promise.all([sha256File(source), sha256File(destination)]);
  if (a !== b) throw new Error(`copy verification failed: ${source} -> ${destination}`);
  return b;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 'B';
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}
