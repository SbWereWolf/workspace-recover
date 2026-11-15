#!/usr/bin/env node
import runtime from '../scripts/npm-runtime.cjs';
process.exitCode = runtime.run(runtime.python, ['-I', '-B', '-m', 'workspace_recover', ...process.argv.slice(2)]);
