#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditDistribution} from './audit.mjs';
import runtime from './npm-runtime.cjs';
const audit = await auditDistribution(runtime.packageRoot);
console.log(`Distribution audit: ${audit.modules} Python modules, ${audit.links} links`);
const result = spawnSync(runtime.python, ['-I', '-B', fileURLToPath(new URL('./check.py', import.meta.url))], {cwd:runtime.packageRoot, stdio:'inherit', shell:false});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
