import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, homeStateDir, nowIso, readJson, sessionId, writeJsonAtomic } from './util.mjs';

export class SessionStore {
  constructor(root = homeStateDir()) {
    this.root = path.resolve(root);
  }

  directory(id) {
    if (typeof id !== 'string' || !/^wr_[br]_\d{14}_[a-f0-9]{12}$/.test(id)) throw new Error('invalid session ID');
    return path.join(this.root, 'sessions', id);
  }

  async create(operation, extra = {}) {
    const id = sessionId(operation === 'backup' ? 'wr_b' : 'wr_r');
    const dir = this.directory(id);
    await ensureDir(dir);
    const session = {
      schema: 'workspace-recover/session/v1',
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
    return session;
  }

  async load(id) {
    return readJson(path.join(this.directory(id), 'session.json'));
  }

  async save(session) {
    session.updatedAt = nowIso();
    await writeJsonAtomic(path.join(this.directory(session.id), 'session.json'), session);
    return session;
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
