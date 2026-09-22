import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

export async function createCleanRoom(sessionId) {
  if(!/^wr_[bri]_\d{14}_[a-f0-9]{12}$/.test(sessionId))throw new Error('invalid clean-room session ID');
  return fsp.mkdtemp(path.join(os.tmpdir(),`workspace-recover-clean-room-${sessionId}-`));
}

/** Only called for our successful rehearsal, never for a user restore target. */
export async function removeCleanRoom(root) {
  const parent=await fsp.realpath(path.dirname(root));
  const temporary=await fsp.realpath(os.tmpdir());
  const top=await fsp.lstat(root);
  if(parent!==temporary || !/^workspace-recover-clean-room-wr_[bri]_\d{14}_[a-f0-9]{12}-[A-Za-z0-9]+$/.test(path.basename(root)) || !top.isDirectory() || top.isSymbolicLink())throw new Error('refusing cleanup outside an owned OS clean room');
  async function prepare(directory) {
    const stat=await fsp.lstat(directory);
    if(!stat.isDirectory() || stat.isSymbolicLink())return;
    // Deletion needs parent write/search. Do not follow links or mutate link targets.
    await fsp.chmod(directory,(stat.mode & 0o7777) | 0o700);
    for(const entry of await fsp.readdir(directory,{withFileTypes:true}))if(entry.isDirectory())await prepare(path.join(directory,entry.name));
  }
  await prepare(root);await fsp.rm(root,{recursive:true,force:true});
}
