import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createTarGz, extractTarGz } from '../src/core/archive.mjs';
import { startBackup, continueBackup } from '../src/core/backup.mjs';
import { executeWorkflow } from '../src/core/workflow.mjs';
import { startRestore, continueRestore } from '../src/core/restore.mjs';
import { SessionStore } from '../src/core/session.mjs';
import { initializeTemplate, loadTemplate, renderTemplate } from '../src/core/template.mjs';
import { driveId, gmailMessageId, googleAuthStatus } from '../src/providers/google-workspace.mjs';
import { pathExists, readJson } from '../src/core/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'workspace-recover.mjs');

async function temp(prefix) { return fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-`)); }

function testTarHeader(name, { type = '0', size = 0, mode = 0o644, linkname = '' } = {}) {
  const header = Buffer.alloc(512, 0);
  const field = (offset, length, value) => Buffer.from(String(value)).copy(header, offset, 0, length);
  const octal = (offset, length, value) => Buffer.from(`${Number(value).toString(8).padStart(length - 1, '0')}\0`).copy(header, offset);
  field(0, 100, name);
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  Buffer.from('        ').copy(header, 148);
  field(156, 1, type);
  if (linkname) field(157, 100, linkname);
  field(257, 6, 'ustar\0');
  field(263, 2, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);
  return header;
}

async function writeRawTarGz(file, entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '');
    chunks.push(testTarHeader(entry.name, { ...entry, size: data.length }));
    if (data.length) {
      chunks.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  await fsp.writeFile(file, zlib.gzipSync(Buffer.concat(chunks)));
}

async function makeSource(root) {
  const source = path.join(root, 'source');
  await fsp.mkdir(path.join(source, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(source, 'a.txt'), 'alpha\n');
  await fsp.writeFile(path.join(source, 'sub', 'b.txt'), 'beta\n');
  await fsp.symlink('sub/b.txt', path.join(source, 'link.txt'));
  return source;
}

function localTemplate(source, backupRoot, workflow = []) {
  return {
    schema: 'workspace-recover/template/v3',
    name: 'test-template',
    inputs: {},
    manifest: {
      schema: 'workspace-recover/manifest/v3',
      name: 'test',
      backup: { source: { path: source, exclude: [] }, transport: { partSizeBytes: 1024 }, provider: { type: 'local-files', root: backupRoot } },
      restore: { target: { required: true }, existingTarget: 'reject', workflow },
      handoff: { provider: { type: 'local-files', root: backupRoot, handoffRoot: path.join(backupRoot, 'handoffs') }, subject: 'test handoff' },
    },
  };
}

async function writeTemplate(root, value) {
  const file = path.join(root, 'template.json');
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

test('generator creates reusable template and values example', async () => {
  const root = await temp('wr-generator');
  const out = path.join(root, 'generated');
  const result = await initializeTemplate({ presetDirectory: path.join(ROOT, 'templates', 'local-project'), outputDirectory: out, name: 'my-backup' });
  assert.equal((await readJson(result.templatePath)).name, 'my-backup');
  const form=await readJson(result.valuesPath);
  assert.equal(form.schema, 'workspace-recover/values/v3');
  assert.equal(form.values.sourcePath, null);
  assert.equal(form.values.partSizeBytes, 67108864);
});

test('template reports missing placeholders without rewriting template', async () => {
  const template = await loadTemplate(path.join(ROOT, 'templates', 'local-project', 'template.json'));
  const rendered = await renderTemplate(template, { projectName: 'x' });
  assert.deepEqual(rendered.missing.sort(), ['backupRoot', 'sourcePath']);
});

test('local backup, clean-room rehearsal, handoff and restore roundtrip', async () => {
  const root = await temp('wr-roundtrip');
  const source = await makeSource(root);
  const backupRoot = path.join(root, 'backups');
  const stateRoot = path.join(root, 'state');
  const templatePath = await writeTemplate(root, localTemplate(source, backupRoot));
  const backup = await startBackup({ templatePath, values: {}, stateRoot });
  assert.equal(backup.state, 'completed');
  const rehearsal = await readJson(path.join(stateRoot, 'sessions', backup.id, 'rehearsal-receipt.json'));
  assert.equal(rehearsal.cleanRoomPreserved, false);
  assert.equal(rehearsal.cleanRoom, null);
  const handoffDir = new URL(backup.handoff.url).pathname;
  assert.equal(await pathExists(path.join(handoffDir, 'workspace-recovery-manifest.json')), true);

  const extracted = path.join(root, 'archive-inspect');
  await extractTarGz({ archive: backup.progress.archive.output, destination: extracted });
  assert.equal(await pathExists(path.join(extracted, 'workspace-recovery-manifest.json')), false);

  const target = path.join(root, 'restored');
  const restored = await startRestore({ handoff: backup.handoff.url, target, stateRoot });
  assert.equal(restored.state, 'completed');
  assert.equal(await fsp.readFile(path.join(target, 'a.txt'), 'utf8'), 'alpha\n');
  assert.equal(await fsp.readlink(path.join(target, 'link.txt')), 'sub/b.txt');
});

test('verification warning is advisory, explicit cleanup runs, clean room is preserved', async () => {
  const root = await temp('wr-warning');
  const source = await makeSource(root);
  const backupRoot = path.join(root, 'backups');
  const stateRoot = path.join(root, 'state');
  const workflow = [
    { id: 'warn', type: 'verification', argv: [process.execPath, '-e', 'process.exit(9)'] },
    { id: 'cleanup', type: 'command', when: 'always', argv: [process.execPath, '-e', "require('fs').writeFileSync('cleanup.marker','done')"] },
  ];
  const templatePath = await writeTemplate(root, localTemplate(source, backupRoot, workflow));
  const backup = await startBackup({ templatePath, values: {}, stateRoot });
  assert.equal(backup.state, 'completed_with_warnings');
  const rehearsal = await readJson(path.join(stateRoot, 'sessions', backup.id, 'rehearsal-receipt.json'));
  assert.equal(rehearsal.restoreStatus, 'success');
  assert.equal(rehearsal.verificationStatus, 'warnings');
  assert.equal(rehearsal.cleanRoomPreserved, true);
  assert.equal(await fsp.readFile(path.join(rehearsal.cleanRoom, 'workspace', 'cleanup.marker'), 'utf8'), 'done');
});

test('missing input resumes the same backup session', async () => {
  const root = await temp('wr-input');
  const source = await makeSource(root);
  const stateRoot = path.join(root, 'state');
  const template = await loadTemplate(path.join(ROOT, 'templates', 'local-project', 'template.json'));
  const templatePath = await writeTemplate(root, template);
  const first = await startBackup({ templatePath, values: { projectName: 'demo', backupRoot: path.join(root, 'backups') }, stateRoot });
  assert.equal(first.state, 'waiting_for_input');
  assert.ok(first.next.command.includes(first.id));
  const store = new SessionStore(stateRoot);
  const resumed = await continueBackup(store, first, { sourcePath: source });
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.state, 'completed');
});

test('restore without target resumes the same session', async () => {
  const root = await temp('wr-restore-input');
  const source = await makeSource(root);
  const backupRoot = path.join(root, 'backups');
  const stateRoot = path.join(root, 'state');
  const templatePath = await writeTemplate(root, localTemplate(source, backupRoot));
  const backup = await startBackup({ templatePath, values: {}, stateRoot });
  const first = await startRestore({ handoff: backup.handoff.url, stateRoot });
  assert.equal(first.state, 'waiting_for_input');
  const store = new SessionStore(stateRoot);
  const resumed = await continueRestore(store, first, { target: path.join(root, 'restored') });
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.state, 'completed');
});

test('Google auth boundary freezes plan and later template edits do not invalidate it', async () => {
  const root = await temp('wr-auth');
  const source = await makeSource(root);
  const template = await loadTemplate(path.join(ROOT, 'templates', 'google-workspace-project', 'template.json'));
  const templatePath = await writeTemplate(root, template);
  const oldConfig = process.env.WORKSPACE_RECOVER_CONFIG_DIR;
  process.env.WORKSPACE_RECOVER_CONFIG_DIR = path.join(root, 'config');
  try {
    const stateRoot = path.join(root, 'state');
    const first = await startBackup({ templatePath, stateRoot, values: { projectName: 'demo', sourcePath: source, driveFolderId: 'folder', gmailTo: 'x@example.com', googleProfile: 'missing' } });
    assert.equal(first.state, 'waiting_for_auth');
    assert.equal(first.planFrozen, true);
    const before = await fsp.readFile(first.planPath, 'utf8');
    template.manifest.name = 'CHANGED-LATER';
    await fsp.writeFile(templatePath, JSON.stringify(template));
    const store = new SessionStore(stateRoot);
    const second = await continueBackup(store, first, {});
    assert.equal(second.state, 'waiting_for_auth');
    assert.equal(await fsp.readFile(first.planPath, 'utf8'), before);
  } finally {
    if (oldConfig === undefined) delete process.env.WORKSPACE_RECOVER_CONFIG_DIR; else process.env.WORKSPACE_RECOVER_CONFIG_DIR = oldConfig;
  }
});

test('custom reporter defines useful medium view', async () => {
  const root = await temp('wr-reporter');
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(workspace);
  const reporter = path.join(root, 'reporter.mjs');
  const domainRecord = path.join(workspace, 'domain-record.txt');
  await fsp.writeFile(domainRecord, 'complete domain record\n');
  await fsp.writeFile(reporter, "process.stdout.write(JSON.stringify({short:'custom short',medium:'domain useful detail',fullPath:'domain-record.txt'}));\n");
  const result = await executeWorkflow({
    workspace,
    sessionDir: path.join(root, 'session'),
    steps: [{ id: 'step', type: 'verification', argv: [process.execPath, '-e', "console.log('raw output')"], report: { profile: 'custom-command', argv: [process.execPath, reporter] } }],
  });
  assert.equal(result.results[0].report.short, 'custom short');
  assert.equal(result.results[0].report.medium, 'domain useful detail');
  assert.ok(result.results[0].report.fullPath.startsWith(path.join(root, 'session') + path.sep));
  await fsp.rm(workspace, { recursive: true });
  assert.equal(await fsp.readFile(result.results[0].report.fullPath, 'utf8'), 'complete domain record\n');
});

test('info full prints only the primary-record path', async () => {
  const root = await temp('wr-info');
  const source = await makeSource(root);
  const backupRoot = path.join(root, 'backups');
  const stateRoot = path.join(root, 'state');
  const templatePath = await writeTemplate(root, localTemplate(source, backupRoot));
  const backup = await startBackup({ templatePath, values: {}, stateRoot });
  const restore = await startRestore({ handoff: backup.handoff.url, target: path.join(root, 'restored'), stateRoot });
  const proc = spawnSync(process.execPath, [CLI, 'info', restore.id, '--type', 'restore', '--view', 'full', '--state-dir', stateRoot], { encoding: 'utf8' });
  assert.equal(proc.status, 0);
  const line = proc.stdout.trim();
  assert.equal(line, path.join(stateRoot, 'sessions', restore.id, 'restore-receipt.json'));
  assert.equal(line.includes('{'), false);
});

test('unsafe symlink escaping restore root is rejected', async () => {
  const root = await temp('wr-symlink');
  const source = path.join(root, 'source');
  await fsp.mkdir(source);
  await fsp.symlink('../../outside', path.join(source, 'bad-link'));
  const archive = path.join(root, 'bad.tar.gz');
  await createTarGz({ source, output: archive });
  await assert.rejects(() => extractTarGz({ archive, destination: path.join(root, 'restore') }), /symlink escapes target/);
});

test('Google reference parsers and credential locations are deterministic', async () => {
  assert.equal(driveId('https://drive.google.com/drive/folders/abc_123'), 'abc_123');
  assert.equal(gmailMessageId('https://mail.google.com/mail/u/0/#all/1a0c53a5b84d8017'), '1a0c53a5b84d8017');
  const old = process.env.WORKSPACE_RECOVER_CONFIG_DIR;
  const root = await temp('wr-auth-path');
  process.env.WORKSPACE_RECOVER_CONFIG_DIR = root;
  try {
    const status = await googleAuthStatus('operator');
    assert.equal(status.clientPath, path.join(root, 'google-workspace', 'operator', 'client.json'));
    assert.equal(status.tokenPath, path.join(root, 'google-workspace', 'operator', 'token.json'));
  } finally {
    if (old === undefined) delete process.env.WORKSPACE_RECOVER_CONFIG_DIR; else process.env.WORKSPACE_RECOVER_CONFIG_DIR = old;
  }
});

test('public CLI resolves a generated template by name', async () => {
  const root = await temp('wr-named-template');
  const config = path.join(root, 'config');
  const state = path.join(root, 'state');
  const source = await makeSource(root);
  const backupRoot = path.join(root, 'backups');
  const env = { ...process.env, WORKSPACE_RECOVER_CONFIG_DIR: config, WORKSPACE_RECOVER_STATE_DIR: state };
  let proc = spawnSync(process.execPath, [CLI, 'template', 'init', 'named-demo', '--preset', 'local-project'], { env, encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  proc = spawnSync(process.execPath, [CLI, 'backup', 'named-demo', '--set', 'projectName=demo', '--set', `sourcePath=${source}`, '--set', `backupRoot=${backupRoot}`, '--set', 'partSizeBytes=1024'], { env, encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /State: completed/);
});

test('all shipped JSON schemas parse and expose workspace-recover IDs', async () => {
  const schemaDir = path.join(ROOT, 'schemas');
  const names = (await fsp.readdir(schemaDir)).filter(name => name.endsWith('.schema.json'));
  assert.ok(names.length >= 10);
  for (const name of names) {
    const schema = JSON.parse(await fsp.readFile(path.join(schemaDir, name), 'utf8'));
    assert.match(schema.$id, /^workspace-recover\//);
  }
});

test('backup accepts an already rendered manifest directly', async () => {
  const root = await temp('wr-manifest-direct');
  const source = await makeSource(root);
  const backupRoot = path.join(root, 'backups');
  const state = path.join(root, 'state');
  const manifest = localTemplate(source, backupRoot).manifest;
  const manifestPath = path.join(root, 'manifest.json');
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const proc = spawnSync(process.execPath, [CLI, 'backup', manifestPath, '--state-dir', state], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /State: completed/);
});


test('hard workflow failure preserves clean room and still runs explicit always cleanup', async () => {
  const root = await temp('wr-hard-failure');
  const source = await makeSource(root);
  const backupRoot = path.join(root, 'backups');
  const stateRoot = path.join(root, 'state');
  const workflow = [
    { id: 'hard', type: 'command', argv: [process.execPath, '-e', 'process.exit(7)'] },
    { id: 'cleanup', type: 'command', when: 'always', argv: [process.execPath, '-e', "require('fs').writeFileSync('hard-cleanup.marker','done')"] },
  ];
  const templatePath = await writeTemplate(root, localTemplate(source, backupRoot, workflow));
  const backup = await startBackup({ templatePath, values: {}, stateRoot });
  assert.equal(backup.state, 'failed');
  const rehearsal = await readJson(path.join(stateRoot, 'sessions', backup.id, 'rehearsal-receipt.json'));
  assert.equal(rehearsal.restoreStatus, 'success');
  assert.equal(rehearsal.workflowHardFailure, true);
  assert.equal(rehearsal.cleanRoomPreserved, true);
  assert.equal(await fsp.readFile(path.join(rehearsal.cleanRoom, 'workspace', 'hard-cleanup.marker'), 'utf8'), 'done');
});

test('tampered recovery manifest in handoff is rejected before restore', async () => {
  const root = await temp('wr-tampered-handoff');
  const source = await makeSource(root);
  const backupRoot = path.join(root, 'backups');
  const stateRoot = path.join(root, 'state');
  const templatePath = await writeTemplate(root, localTemplate(source, backupRoot));
  const backup = await startBackup({ templatePath, values: {}, stateRoot });
  const handoffDir = new URL(backup.handoff.url).pathname;
  const recoveryPath = path.join(handoffDir, 'workspace-recovery-manifest.json');
  await fsp.appendFile(recoveryPath, '\n');
  await assert.rejects(
    () => startRestore({ handoff: backup.handoff.url, target: path.join(root, 'restored'), stateRoot }),
    /recovery manifest hash mismatch/,
  );
});

test('archive path traversal is rejected before writing outside target', async () => {
  const root = await temp('wr-traversal');
  const archive = path.join(root, 'traversal.tar.gz');
  await writeRawTarGz(archive, [{ name: '../escape.txt', data: 'escape' }]);
  const destination = path.join(root, 'restore');
  await assert.rejects(() => extractTarGz({ archive, destination }), /unsafe archive path/);
  assert.equal(await pathExists(path.join(root, 'escape.txt')), false);
});

test('archive with invalid tar header checksum is rejected', async () => {
  const root = await temp('wr-tar-checksum');
  const archive = path.join(root, 'checksum.tar.gz');
  const header = testTarHeader('ok.txt', { size: 2 });
  header[20] ^= 0x01;
  const payload = Buffer.concat([header, Buffer.from('ok'), Buffer.alloc(510), Buffer.alloc(1024)]);
  await fsp.writeFile(archive, zlib.gzipSync(payload));
  await assert.rejects(() => extractTarGz({ archive, destination: path.join(root, 'restore') }), /invalid tar header checksum/);
});

test('clean-room rehearsal downloads through the shared recovery executor', async () => {
  const root = await temp('wr-shared-engine');
  const source = await makeSource(root);
  const backupRoot = path.join(root, 'backups');
  const stateRoot = path.join(root, 'state');
  const templatePath = await writeTemplate(root, localTemplate(source, backupRoot));
  const backup = await startBackup({ templatePath, values: {}, stateRoot });
  const rehearsalDownloads = path.join(stateRoot, 'sessions', backup.id, 'rehearsal', 'downloads');
  assert.equal(await pathExists(rehearsalDownloads), true);
  const names = await fsp.readdir(rehearsalDownloads);
  assert.ok(names.some(name => name.endsWith('.part-000')));
  assert.ok(names.includes('workspace-backup.tar.gz'));
});


test('restore defers read-only directory modes until children are extracted', async () => {
  if (process.platform === 'win32') return;
  const root = await temp('wr-readonly-dir');
  await fsp.chmod(root, 0o777);
  const archive = path.join(root, 'readonly.tar.gz');
  await writeRawTarGz(archive, [
    { name: 'locked/', type: '5', mode: 0o555 },
    { name: 'locked/child.txt', type: '0', mode: 0o444, data: 'payload\n' },
  ]);
  await fsp.chmod(archive, 0o644);
  const destination = path.join(root, 'restore');
  // A private 0700 installation/clean-room root need not be readable by nobody.
  // Stage only the actual unmodified module bytes for the uid-drop regression.
  const stagedCore=path.join(root, 'core');
  await fsp.cp(path.join(ROOT, 'src', 'core'), stagedCore, {recursive:true});
  await fsp.chmod(stagedCore, 0o755);
  const moduleUrl = pathToFileURL(path.join(stagedCore, 'archive.mjs')).href;
  const script = `import { extractTarGz } from ${JSON.stringify(moduleUrl)}; await extractTarGz({archive:${JSON.stringify(archive)}, destination:${JSON.stringify(destination)}});`;
  const options = { encoding: 'utf8' };
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    options.uid = 65534;
    options.gid = 65534;
  }
  const proc = spawnSync(process.execPath, ['--input-type=module', '-e', script], options);
  assert.equal(proc.status, 0, `stdout=${proc.stdout}\nstderr=${proc.stderr}`);
  assert.equal(await fsp.readFile(path.join(destination, 'locked', 'child.txt'), 'utf8'), 'payload\n');
  assert.equal((await fsp.stat(path.join(destination, 'locked'))).mode & 0o7777, 0o555);
  assert.equal((await fsp.stat(path.join(destination, 'locked', 'child.txt'))).mode & 0o7777, 0o444);
});

test('backup and restore preserve the source workspace root mode', async () => {
  if (process.platform === 'win32') return;
  const root = await temp('wr-root-mode');
  const source = await makeSource(root);
  await fsp.chmod(source, 0o711);
  const archive = path.join(root, 'root-mode.tar.gz');
  await createTarGz({ source, output: archive });
  const destination = path.join(root, 'restore');
  await extractTarGz({ archive, destination });
  assert.equal((await fsp.stat(destination)).mode & 0o7777, 0o711);
});

test('restore preserves an explicit zero permission mode instead of replacing it with 0644', async () => {
  if (process.platform === 'win32') return;
  const root = await temp('wr-zero-mode');
  const archive = path.join(root, 'zero-mode.tar.gz');
  await writeRawTarGz(archive, [
    { name: 'sealed.txt', type: '0', mode: 0o000, data: 'sealed\n' },
  ]);
  const destination = path.join(root, 'restore');
  await extractTarGz({ archive, destination });
  assert.equal((await fsp.stat(path.join(destination, 'sealed.txt'))).mode & 0o7777, 0o000);
});

test('full backup rehearsal and handoff restore preserve restrictive directory and root modes', async () => {
  if (process.platform === 'win32') return;
  const root = await temp('wr-restrictive-roundtrip');
  const source = await makeSource(root);
  await fsp.chmod(source, 0o711);
  await fsp.chmod(path.join(source, 'sub'), 0o555);
  await fsp.chmod(path.join(source, 'sub', 'b.txt'), 0o444);
  const backupRoot = path.join(root, 'backups');
  const stateRoot = path.join(root, 'state');
  const templatePath = await writeTemplate(root, localTemplate(source, backupRoot));
  const backup = await startBackup({ templatePath, values: {}, stateRoot });
  assert.equal(backup.state, 'completed');
  const target = path.join(root, 'restored');
  const restored = await startRestore({ handoff: backup.handoff.url, target, stateRoot });
  assert.equal(restored.state, 'completed');
  assert.equal((await fsp.stat(target)).mode & 0o7777, 0o711);
  assert.equal((await fsp.stat(path.join(target, 'sub'))).mode & 0o7777, 0o555);
  assert.equal((await fsp.stat(path.join(target, 'sub', 'b.txt'))).mode & 0o7777, 0o444);
});

test('failed extraction does not leave observed directories with temporary relaxed permissions', async () => {
  if (process.platform === 'win32') return;
  const root = await temp('wr-failed-mode');
  const archive = path.join(root, 'failed-mode.tar.gz');
  const goodDir = testTarHeader('locked/', { type: '5', mode: 0o555 });
  const badHeader = testTarHeader('locked/bad.txt', { size: 1, mode: 0o444 });
  badHeader[20] ^= 0x01;
  await fsp.writeFile(archive, zlib.gzipSync(Buffer.concat([goodDir, badHeader, Buffer.from('x'), Buffer.alloc(511), Buffer.alloc(1024)])));
  const destination = path.join(root, 'restore');
  await assert.rejects(() => extractTarGz({ archive, destination }), /invalid tar header checksum/);
  assert.equal((await fsp.stat(path.join(destination, 'locked'))).mode & 0o7777, 0o555);
});
