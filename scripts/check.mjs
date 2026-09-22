#!/usr/bin/env node
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDistribution } from './audit.mjs';
import { spawnSync } from 'node:child_process';

// This runner belongs to this package and works without a parent repository.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audit=await auditDistribution(root);console.log(`Distribution audit: ${audit.json} JSON, ${audit.markdown} Markdown, ${audit.links} links, ${audit.modules} isolated runtime modules`);
const source = [];
async function collect(directory) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (entry.isFile() && file.endsWith('.mjs')) source.push(file);
  }
}
for (const sub of ['bin', 'src', 'scripts', 'tests']) await collect(path.join(root, sub));
for (const file of source.sort()) {
  const check = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit', shell: false });
  if (check.error) throw check.error;
  if (check.status !== 0) process.exit(check.status ?? 1);
}
const tests = source.filter(file => file.endsWith('.test.mjs'));
if (!tests.length) throw new Error('No contract tests found');
const sandbox=await fsp.mkdtemp(path.join(os.tmpdir(),'wr-contract-environment-'));
const env={...process.env,WORKSPACE_RECOVER_CONFIG_DIR:path.join(sandbox,'config'),WORKSPACE_RECOVER_STATE_DIR:path.join(sandbox,'state'),WORKSPACE_RECOVER_CACHE_DIR:path.join(sandbox,'cache')};
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, env, stdio: 'inherit', shell: false });
if(result.status===0)await fsp.rm(sandbox,{recursive:true,force:true});
else console.error(`Test environment preserved: ${sandbox}`);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
