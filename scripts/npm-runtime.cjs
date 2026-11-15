'use strict';
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const packageRoot = path.resolve(__dirname, '..');
const python = path.join(packageRoot, '.venv', 'bin', 'python');
function run(executable, args) {
  const result = spawnSync(executable, args, {stdio:'inherit', shell:false});
  if (result.error) { console.error(`workspace-recover: ${result.error.message}`); return 2; }
  if (result.signal) { process.kill(process.pid, result.signal); return 2; }
  return result.status;
}
module.exports = {packageRoot, python, run};
