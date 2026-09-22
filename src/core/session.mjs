import { assertFormat } from './formats.mjs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, homeStateDir, nowIso, readJson, sha256Text, pathExists, sessionId, writeJsonAtomic } from './util.mjs';

export class SessionStore {
  constructor(root = homeStateDir()) {
    this.root = path.resolve(root);
  }

  directory(id) {
    if (typeof id !== 'string' || !/^wr_[bri]_\d{14}_[a-f0-9]{12}$/.test(id)) throw new Error('invalid session ID');
    return path.join(this.root, 'sessions', id);
  }

  async create(operation, extra = {}) {
    const id = sessionId(({backup:'wr_b',restore:'wr_r',init:'wr_i'})[operation] || 'wr_r');
    const dir = this.directory(id);
    await ensureDir(dir);
    const session = {
      schema: 'workspace-recover/session/v3',
      id,
      operation,
      state: 'running',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      next: null,
      info: {},
      ...extra,
    };
    await this.save(session);
    await this.remember(id, process.cwd());
    return session;
  }

  async load(id) {
    return assertFormat(await readJson(path.join(this.directory(id), 'session.json')), 'session');
  }

  async save(session) {
    session.updatedAt = nowIso();
    this.saving=(this.saving || Promise.resolve()).catch(()=>{}).then(()=>writeJsonAtomic(path.join(this.directory(session.id), 'session.json'), session));
    await this.saving;
    return session;
  }

  async remember(id, scope = process.cwd()) {
    this.directory(id);
    const key=sha256Text(path.resolve(scope));
    await writeJsonAtomic(path.join(this.root,'current',`${key}.json`),{schema:'workspace-recover/current-session/v3',sessionId:id,scope:path.resolve(scope)});
  }

  async current(scope = process.cwd()) {
    const file=path.join(this.root,'current',`${sha256Text(path.resolve(scope))}.json`);
    if(!await pathExists(file))throw new Error('No current session in this project/directory. Supply an explicit session ID.');
    const pointer=assertFormat(await readJson(file),'current-session');
    await this.load(pointer.sessionId);return pointer.sessionId;
  }

  async write(id, relative, value, mode = 0o600) {
    const file = path.join(this.directory(id), relative);
    await ensureDir(path.dirname(file));
    if (typeof value === 'string' || Buffer.isBuffer(value)) await fsp.writeFile(file, value, { mode });
    else await writeJsonAtomic(file, value, mode);
    return file;
  }

  async attempt(session, action) {
    try { return await action(); }
    catch (error) {
      if (['EXTERNAL_PENDING','CAPABILITY_REQUIRED','EXTERNAL_OUTCOME_UNKNOWN'].includes(error?.code)) {
        session.state=error.code==='CAPABILITY_REQUIRED'?'waiting_for_capability':error.code==='EXTERNAL_OUTCOME_UNKNOWN'?'waiting_for_reconciliation':'waiting_for_connector';
        session.next={...(session.next||{}),type:'automatic',action:error.code==='EXTERNAL_OUTCOME_UNKNOWN'?'reconcile-external-outcome':'host-connectors',reason:error.message,requestId:error.request?.requestId||null};
        await this.save(session);return session;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      const fullPath = await this.write(session.id, 'error.json', {
        sessionId: session.id, operation: session.operation, failedAt: nowIso(),
        message: failure.message, code: failure.code || null, stack: failure.stack,
        progress: session.progress || {},
      });
      session.state = 'failed';
      session.result = { ...(session.result || {}), operation: 'failed' };
      session.info.error = { short: failure.message, medium: `Operation: ${session.operation}\nCause: ${failure.message}\nPreserved evidence: ${fullPath}`, fullPath };
      session.next = { type: 'manual', action: 'inspect-error', command: `workspace-recover info ${session.id} --type error --view medium`, reason: 'Inspect preserved evidence before starting a new operation.' };
      await this.save(session);
      failure.sessionId = session.id; failure.session = session; failure.stateRoot = this.root;
      throw failure;
    }
  }

  async setInfo(session, type, { short, medium, fullPath }) {
    session.info[type] = { short, medium, fullPath };
    await this.save(session);
  }
}

export function terminalState(state) {
  return ['completed', 'completed_with_warnings', 'failed', 'aborted'].includes(state);
}
