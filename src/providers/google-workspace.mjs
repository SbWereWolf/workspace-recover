import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { profileName } from '../core/profiles.mjs';
import { spawn } from 'node:child_process';
import { decodeBase64Url, encodeBase64Url, ensureDir, homeConfigDir, nowIso, pathExists, readJson, sha256File, writeJsonAtomic } from '../core/util.mjs';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

export function googleProfileDir(profile = 'default') {
  return path.join(homeConfigDir(), 'google-workspace', profileName(profile));
}

function clientValues(raw) {
  const data = raw.installed || raw.web || raw;
  if (!data.client_id || !data.client_secret) throw new Error('Google OAuth client JSON must contain client_id and client_secret');
  return { clientId: data.client_id, clientSecret: data.client_secret };
}

export async function googleAuthStatus(profile = 'default') {
  const dir = googleProfileDir(profile);
  return {
    profile,
    clientPath: path.join(dir, 'client.json'),
    tokenPath: path.join(dir, 'token.json'),
    clientPresent: await pathExists(path.join(dir, 'client.json')),
    tokenPresent: await pathExists(path.join(dir, 'token.json')),
  };
}

function openBrowser(url) {
  const commands = process.platform === 'darwin' ? [['open', [url]]] : process.platform === 'win32' ? [['cmd', ['/c', 'start', '', url]]] : [['xdg-open', [url]]];
  const [command, args] = commands[0];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error',()=>{});child.unref();
  } catch {}
}

export async function authorizeGoogleWorkspace({ clientFile, profile = 'default', scopes = GOOGLE_SCOPES, noBrowser = false, timeoutMs = 300000 }) {
  const dir = googleProfileDir(profile);
  await ensureDir(dir);
  if (clientFile) {
    const raw = await readJson(clientFile);
    clientValues(raw);
    await writeJsonAtomic(path.join(dir, 'client.json'), raw);
  }
  const clientPath = path.join(dir, 'client.json');
  if (!await pathExists(clientPath)) throw new Error(`Google OAuth client credentials missing: ${clientPath}`);
  const { clientId, clientSecret } = clientValues(await readJson(clientPath));
  const state = crypto.randomBytes(24).toString('hex');
  const verifier=crypto.randomBytes(32).toString('base64url');
  const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/oauth2/callback') { res.statusCode = 404; res.end('Not found'); return; }
      if (url.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
      const error = url.searchParams.get('error');
      if (error) throw new Error(`Google authorization failed: ${error}`);
      const code = url.searchParams.get('code');
      if (!code) throw new Error('OAuth callback did not contain an authorization code');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('workspace-recover authorization received. You can close this browser tab.');
      resolveCode(code);
    } catch (error) {
      res.statusCode = 400; res.end(String(error.message || error)); rejectCode(error);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge',challenge);
  authUrl.searchParams.set('code_challenge_method','S256');
  process.stdout.write(`Open this URL to authorize Google Workspace:\n${authUrl}\n`);
  if (!noBrowser) openBrowser(authUrl.toString());
  let code;
  const timeout=setTimeout(()=>rejectCode(new Error('OAuth callback timed out; authorize again')),timeoutMs);
  try { code = await codePromise; } finally { clearTimeout(timeout);server.close(); }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code_verifier:verifier, code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed: HTTP ${response.status}`);
  const token = await response.json();
  if (!token.refresh_token) throw new Error('Google did not return a refresh token; revoke prior app access and authorize again with consent');
  const stored = { ...token, obtained_at: nowIso(), expires_at: Date.now() + Number(token.expires_in || 3600) * 1000, scopes };
  await writeJsonAtomic(path.join(dir, 'token.json'), stored);
  return { profile, tokenPath: path.join(dir, 'token.json'), scopes };
}

async function accessToken(profile) {
  const dir = googleProfileDir(profile);
  const clientPath = path.join(dir, 'client.json');
  const tokenPath = path.join(dir, 'token.json');
  if (!await pathExists(clientPath) || !await pathExists(tokenPath)) {
    const error = new Error(`Google Workspace authorization is required for profile ${profile}`);
    error.code = 'AUTH_REQUIRED';
    error.authCommand = `workspace-recover auth google-workspace --profile ${profile} --client <oauth-client.json>`;
    throw error;
  }
  const { clientId, clientSecret } = clientValues(await readJson(clientPath));
  const token = await readJson(tokenPath);
  if (token.access_token && Number(token.expires_at || 0) > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) throw new Error(`Google refresh token missing: ${tokenPath}`);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: token.refresh_token, grant_type: 'refresh_token' }),
  });
  if (!response.ok) {
    const data=await response.json().catch(()=>({}));
    const error=new Error(`Google token refresh failed: HTTP ${response.status}; ${data.error || 'unknown_error'}`);
    if(data.error==='invalid_grant'){error.code='AUTH_REQUIRED';error.authCommand=`workspace-recover auth google-workspace --profile ${profile}`;}
    throw error;
  }
  const refreshed = await response.json();
  const updated = { ...token, ...refreshed, refresh_token: token.refresh_token, expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000, refreshed_at: nowIso() };
  await writeJsonAtomic(tokenPath, updated);
  if(typeof updated.access_token!=='string' || !updated.access_token)throw new Error('Google refresh response has no access token');
  return updated.access_token;
}

async function googleFetch(profile, url, options = {}) {
  const token = await accessToken(profile);
  const headers = new Headers(options.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  const endpoint=new URL(url);
  if(endpoint.protocol!=='https:' || !['www.googleapis.com','gmail.googleapis.com'].includes(endpoint.hostname))throw new Error('unexpected Google API endpoint');
  const response = await fetch(url, { ...options, headers,redirect:'error',signal:options.signal || AbortSignal.timeout(120000) });
  if (!response.ok) {const e=new Error(`Google API request failed: HTTP ${response.status}`);if(response.status===401){e.code='AUTH_REQUIRED';e.authCommand=`workspace-recover auth google-workspace --profile ${profile}`;}throw e;}
  return response;
}

function driveId(value) {
  if(value===null || value===undefined || value==='')return null;
  if(typeof value!=='string')throw new Error('invalid Google Drive ID');
  if(/^[A-Za-z0-9_-]+$/.test(value))return value;
  let url;try{url=new URL(value);}catch{throw new Error('invalid Google Drive URL/ID');}
  if(url.protocol!=='https:' || url.hostname!=='drive.google.com' || url.username || url.password)throw new Error('invalid Google Drive URL host');
  const match=url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)\/?$/) || url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)(?:\/view)?\/?$/);
  if(!match)throw new Error('invalid Google Drive URL path');return match[1];
}

function gmailMessageId(value) {
  if(typeof value!=='string')throw new Error('invalid Gmail message ID');
  if(/^[a-f0-9]{12,40}$/i.test(value))return value;
  let url;try{url=new URL(value);}catch{throw new Error('invalid Gmail message ID or URL');}
  if(url.protocol!=='https:' || url.hostname!=='mail.google.com' || url.username || url.password)throw new Error('invalid Gmail message URL host');
  const id=url.hash.split('/').at(-1);
  if(!/^[a-f0-9]{12,40}$/i.test(id || ''))throw new Error('Gmail URL requires a hexadecimal API message ID; opaque UI-only identifiers are not API IDs');
  return id;
}

async function streamToFile(response, destination) {
  await ensureDir(path.dirname(destination));
  const file = fs.createWriteStream(destination, { mode: 0o600 });
  await new Promise(async (resolve, reject) => {
    file.on('error', reject);
    file.on('close', resolve);
    try {
      for await (const chunk of response.body) if (!file.write(chunk)) await new Promise(r => file.once('drain', r));
      file.end();
    } catch (error) { file.destroy(error); }
  });
}

function mimeHeader(value) {
  return /[^\x20-\x7E]/.test(value) ? `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=` : value;
}

async function makeRawEmail({ to, subject, body, attachments }) {
  for(const value of [to,subject])if(typeof value!=='string' || /[\r\n\0]/.test(value))throw new Error('unsafe MIME header');
  for(const a of attachments)if(typeof a.name!=='string' || /[\r\n\0\\/"]/.test(a.name) || !a.name)throw new Error('unsafe attachment filename');
  const boundary = `wr_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${mimeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ];
  for (const attachment of attachments) {
    const data = await fsp.readFile(attachment.path);
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType || 'application/octet-stream'}; name="${attachment.name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.name}"`,
      '',
      data.toString('base64').match(/.{1,76}/g)?.join('\r\n') || '',
    );
  }
  lines.push(`--${boundary}--`, '');
  return encodeBase64Url(Buffer.from(lines.join('\r\n')));
}

async function gmailPartBytes(profile, messageId, part) {
  if (part.body?.data) return decodeBase64Url(part.body.data);
  if (part.body?.attachmentId) {
    const response = await googleFetch(profile, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`);
    const data = await response.json();
    return decodeBase64Url(data.data || '');
  }
  return Buffer.alloc(0);
}

function flattenParts(payload, result = []) {
  result.push(payload);
  for (const part of payload.parts || []) flattenParts(part, result);
  return result;
}

export class GoogleWorkspaceProvider {
  constructor({ profile = 'default', driveFolderId = null }) {
    this.type = 'google-workspace';
    this.profile = profileName(profile);
    this.driveFolderId = driveId(driveFolderId);
  }

  async ready() { await accessToken(this.profile); return { ready: true }; }

  async upload(file, { name = path.basename(file), folderId = this.driveFolderId } = {}) {
    folderId = driveId(folderId);
    if (!folderId) throw new Error('Google Drive folder ID is required for upload');
    const stat = await fsp.stat(file);
    const start = await googleFetch(this.profile, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink,parents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'application/octet-stream',
        'x-upload-content-length': String(stat.size),
      },
      body: JSON.stringify({ name, parents: [folderId] }),
    });
    const location = start.headers.get('location');
    if (!location) throw new Error('Google Drive resumable upload did not return a Location header');
    const uploadURL=new URL(location);
    if(uploadURL.protocol!=='https:' || uploadURL.hostname!=='www.googleapis.com' || uploadURL.username || uploadURL.password || !uploadURL.pathname.startsWith('/upload/drive/v3/files'))throw new Error('unexpected Google upload endpoint URL');
    const token = await accessToken(this.profile);
    const response = await fetch(location, {
      method: 'PUT',redirect:'error',signal:AbortSignal.timeout(120000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(stat.size) },
      body: fs.createReadStream(file),
      duplex: 'half',
    });
    if (!response.ok) throw new Error(`Google Drive upload failed: HTTP ${response.status}`);
    const data = await response.json();
    if(!data.id)throw new Error('Google Drive upload has no file ID');driveId(data.id);
    return { id: data.id, name: data.name, bytes: Number(data.size || stat.size), url: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`, parent: folderId, sha256: await sha256File(file) };
  }

  async metadata(ref) {
    const id = driveId(ref.id || ref.url || ref);
    const response = await googleFetch(this.profile, `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,size,webViewLink,parents`);
    const data = await response.json();
    if(!data.id)throw new Error('Google Drive upload has no file ID');driveId(data.id);
    return { id: data.id, name: data.name, bytes: Number(data.size || 0), url: data.webViewLink, parents: data.parents || [], parent: data.parents?.[0] || null };
  }

  async download(ref, destination, { expectedFolderId = null } = {}) {
    const id = driveId(ref.id || ref.url || ref);
    const metadata = await this.metadata(id);
    if (expectedFolderId && !metadata.parents.includes(driveId(expectedFolderId))) throw new Error(`Drive file ${id} is not in expected folder ${driveId(expectedFolderId)}`);
    const response = await googleFetch(this.profile, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    await streamToFile(response, destination);
    return destination;
  }

  async sendHandoff({ to, subject, body, attachments }) {
    const raw = await makeRawEmail({ to, subject, body, attachments });
    const response = await googleFetch(this.profile, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }),
    });
    const data = await response.json();
    return { id: data.id, threadId: data.threadId, url: `https://mail.google.com/mail/u/0/#all/${data.id}` };
  }

  async readHandoff(reference, destinationDirectory) {
    const id = gmailMessageId(reference);
    if (!id) throw new Error(`cannot parse Gmail message ID from ${reference}`);
    const response = await googleFetch(this.profile, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`);
    const data = await response.json();
    await ensureDir(destinationDirectory);
    const attachments = {};
    const requiredNames=new Set(['workspace-handoff.json','workspace-recovery-manifest.json','workspace-transport-manifest.json','workspace-backup-receipt.json','workspace-rehearsal-receipt.json']);
    let body = '';
    for (const part of flattenParts(data.payload)) {
      const filename = part.filename || '';
      if (filename) {
        if(/[\\/\0]/.test(filename) || ['.','..'].includes(filename))throw new Error('unsafe handoff attachment name');
        if(!requiredNames.has(filename))continue;
        if(Object.hasOwn(attachments,filename))throw new Error('duplicate handoff attachment');
        const bytes = await gmailPartBytes(this.profile, id, part);
        const target = path.join(destinationDirectory, path.basename(filename));
        await fsp.writeFile(target, bytes, { mode: 0o600 });
        attachments[path.basename(filename)] = target;
      } else if (!body && part.mimeType === 'text/plain') {
        body = (await gmailPartBytes(this.profile, id, part)).toString('utf8');
      }
    }
    const header=name=>data.payload?.headers?.find(h=>h.name.toLowerCase()===name)?.value;
    return { id, body, subject:header('subject'), to:header('to'), attachments, raw: data };
  }
}

export { driveId, gmailMessageId };
