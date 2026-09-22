import os from 'node:os';
import fs from 'node:fs';
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
    // Linux O_PATH pins even a mode-0000 directory without opening its contents.
    const flags=(process.platform==='linux' ? 0x200000 : fs.constants.O_RDONLY) | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0);
    const handle=await fsp.open(directory,flags);
    try {
      const held=await handle.stat();
      if(!held.isDirectory() || held.dev!==stat.dev || held.ino!==stat.ino)throw new Error('clean-room directory changed during cleanup');
      // Descriptor chmod cannot be redirected through a swapped symlink.
      const anchor=process.platform==='linux' ? `/proc/self/fd/${handle.fd}` : directory;
      if(process.platform==='linux')await fsp.chmod(anchor,(held.mode & 0o7777) | 0o700);
      else await handle.chmod((held.mode & 0o7777) | 0o700);
      for(const entry of await fsp.readdir(anchor,{withFileTypes:true}))if(entry.isDirectory())await prepare(path.join(anchor,entry.name));
    } finally {await handle.close();}
  }
  await prepare(root);await fsp.rm(root,{recursive:true,force:true});
}
