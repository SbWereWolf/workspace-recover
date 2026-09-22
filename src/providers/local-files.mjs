import { assertFormat } from '../core/formats.mjs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { copyFileVerified, ensureDir, pathExists, readJson, sha256File, writeJsonAtomic, writeTextAtomic } from '../core/util.mjs';

export class LocalFilesProvider {
  constructor({ root, handoffRoot = null, readOnly = false }) {
    this.type = 'local-files';this.readOnly=readOnly;
    this.root = path.resolve(root);
    this.handoffRoot = path.resolve(handoffRoot || path.join(this.root, 'handoffs'));
  }

  async ready() {
    if(this.readOnly)return {ready:true};
    await ensureDir(this.root);
    await ensureDir(this.handoffRoot);
    return { ready: true };
  }

  async upload(file, { name = path.basename(file) } = {}) {
    const destination = path.join(this.root, name);
    await copyFileVerified(file, destination);
    const stat = await fsp.stat(destination);
    return { id: destination, name, url: `file://${destination}`, bytes: stat.size, sha256: await sha256File(destination), parent: this.root };
  }

  async metadata(ref) {
    const file = path.resolve(ref.id || ref.path || ref);
    const stat = await fsp.stat(file);
    return { id: file, name: path.basename(file), bytes: stat.size, parent: path.dirname(file), shared: false };
  }

  async download(ref, destination) {
    const source = path.resolve(ref.id || ref.path || ref);
    await copyFileVerified(source, destination);
    return destination;
  }

  async sendHandoff({ sessionId, to, subject, body, attachments }) {
    const dir = path.join(this.handoffRoot, sessionId);
    await ensureDir(dir);
    await writeTextAtomic(path.join(dir, 'HANDOFF.md'), `${body}\n`, 0o644);
    const copied = [];
    for (const attachment of attachments) {
      const target = path.join(dir, attachment.name || path.basename(attachment.path));
      await copyFileVerified(attachment.path, target);
      copied.push({ name: path.basename(target), path: target, sha256: await sha256File(target) });
    }
    const index = { schema: 'workspace-recover/handoff-local/v3', sessionId, to, subject, bodyFile: 'HANDOFF.md', attachments: copied };
    await writeJsonAtomic(path.join(dir, 'handoff.json'), index, 0o644);
    return { id: dir, url: `file://${dir}`, dir };
  }

  async readHandoff(reference, destinationDirectory = null) {
    let dir = reference;
    if (reference.startsWith('file://')) dir = new URL(reference).pathname;
    const stat = await fsp.stat(dir);
    if (stat.isFile()) dir = path.dirname(dir);
    const index = assertFormat(await readJson(path.join(dir, 'handoff.json')),'handoff-local');
    let readDir = dir;
    if (destinationDirectory) {
      await ensureDir(destinationDirectory);
      readDir = destinationDirectory;
      await copyFileVerified(path.join(dir, index.bodyFile), path.join(readDir, index.bodyFile));
      await copyFileVerified(path.join(dir, 'handoff.json'), path.join(readDir, 'handoff.json'));
      for (const item of index.attachments) await copyFileVerified(path.join(dir, item.name), path.join(readDir, item.name));
    }
    const attachments = {};
    for (const item of index.attachments) attachments[item.name] = path.join(readDir, item.name);
    return { id: dir, subject:index.subject, to:index.to, body: await fsp.readFile(path.join(readDir, index.bodyFile), 'utf8'), attachments, index };
  }
}
