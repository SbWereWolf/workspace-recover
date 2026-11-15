'use strict';
const path = require('node:path');
const {packageRoot, python, run} = require('./npm-runtime.cjs');
function main() {
  const selected = process.env.WORKSPACE_RECOVER_PYTHON;
  if (!selected) { console.error('workspace-recover: WORKSPACE_RECOVER_PYTHON is required for installation'); return 2; }
  const status = run(selected, ['-P','-s','-B','-m','venv','--copies',path.join(packageRoot,'.venv')]);
  return status || run(python, ['-P','-s','-B','-m','pip','install',packageRoot]);
}
process.exitCode = main();
