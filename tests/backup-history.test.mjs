import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startBackupFromManifest } from '../src/core/backup.mjs';
import { startRestore } from '../src/core/restore.mjs';
import { readJson, sha256File } from '../src/core/util.mjs';

async function fixture(t, workflow = []) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wr-history-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, 'data.txt'), 'first version\n');
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = {
    schema: 'workspace-recover/manifest/v1', name: 'history-test',
    backup: { source: { path: source, exclude: [] }, transport: { partSizeBytes: 1024 }, provider: { type: 'local-files', root: path.join(root, 'objects') } },
    restore: { existingTarget: 'reject', workflow },
    handoff: { provider: { type: 'local-files', root: path.join(root, 'handoff-provider'), handoffRoot: path.join(root, 'mail') }, subject: 'rebranding' },
  };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  return { root, source, manifest, manifestPath, stateRoot: path.join(root, 'state') };
}

test('successive backups cannot replace the bytes referenced by an older handoff', async t => {
  const f = await fixture(t);
  const first = await startBackupFromManifest(f);
  const firstPart = first.progress.uploadedParts[0];
  const oldHash = await sha256File(firstPart.id);
  await fsp.writeFile(path.join(f.source, 'data.txt'), 'second version\n');
  const second = await startBackupFromManifest(f);
  assert.notEqual(firstPart.id, second.progress.uploadedParts[0].id);
  assert.equal(await sha256File(firstPart.id), oldHash);
  const oldTarget = path.join(f.root, 'old-restored');
  const restored = await startRestore({ handoff: first.handoff.url, target: oldTarget, stateRoot: f.stateRoot });
  assert.equal(restored.state, 'completed');
  assert.equal(await fsp.readFile(path.join(oldTarget, 'data.txt'), 'utf8'), 'first version\n');
});

test('handoff provider settings are honored even when its type matches artifact provider', async t => {
  const f = await fixture(t);
  const session = await startBackupFromManifest(f);
  assert.equal(path.dirname(new URL(session.handoff.url).pathname), path.join(f.root, 'mail'));
});

test('per-step full JSON report survives explicit cleanup and successful clean-room deletion', async t => {
  const f = await fixture(t, [
    { id: 'check', type: 'verification', argv: [process.execPath, '-e', `require('fs').writeFileSync('result.json', JSON.stringify({passed:4, tests:4}))`], report: { profile: 'json', source: 'result.json', shortKey: 'passed' } },
    { id: 'cleanup', type: 'command', argv: [process.execPath, '-e', `require('fs').unlinkSync('result.json')`] },
  ]);
  const s = await startBackupFromManifest(f);
  assert.equal(s.state, 'completed');
  const report = s.info['step:check'];
  assert.ok(report, 'each manifest step must have an addressable report');
  assert.ok(report.fullPath.startsWith(f.stateRoot + path.sep));
  assert.deepEqual(await readJson(report.fullPath), {passed:4, tests:4});
  const workflow = await readJson(s.info.workflow.fullPath);
  assert.equal(workflow.items[0].report.fullPath, report.fullPath);
  assert.equal(workflow.items[0].report.sourceArtifact.sha256, await sha256File(report.fullPath));
});

test('JUnit full report remains an exact file after clean room removal', async t => {
  const xml = '<testsuite tests="2" failures="0" errors="0" skipped="0" time="0.01"></testsuite>';
  const f = await fixture(t, [{ id:'junit', type:'verification', argv:[process.execPath, '-e', `require('fs').writeFileSync('junit.xml', ${JSON.stringify(xml)})`], report:{profile:'junit', source:'junit.xml'} }]);
  const s = await startBackupFromManifest(f);
  assert.ok(s.info['step:junit']);
  assert.equal(await fsp.readFile(s.info['step:junit'].fullPath, 'utf8'), xml);
});

test('custom reporter primary output is saved without re-executing the parser during info', async t => {
  const f = await fixture(t, [{ id:'custom', type:'verification', argv:[process.execPath, '-e', `require('fs').writeFileSync('evidence.txt','raw evidence')`], report:{profile:'custom-command', argv:[process.execPath, '-e', `process.stdout.write(JSON.stringify({short:'one record', medium:'one useful record; all passed', fullPath:'evidence.txt'}))`]} }]);
  const s = await startBackupFromManifest(f);
  assert.equal(await fsp.readFile(s.info['step:custom'].fullPath, 'utf8'), 'raw evidence');
});

test('handoff full report is a readable primary file, not a directory', async t => {
  const f = await fixture(t);
  const s = await startBackupFromManifest(f);
  assert.equal((await fsp.stat(s.info.handoff.fullPath)).isFile(), true);
  const r = await readJson(s.info.handoff.fullPath);
  assert.equal(r.id, s.handoff.id);
  assert.equal(r.readbackVerified, true);
});
