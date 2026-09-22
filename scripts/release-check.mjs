import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditDistribution } from './audit.mjs';

/** Check a release in this folder's own repository; never modify Git or its parent. */
export async function checkRelease(root,{git=false}={}) {
  const report=await auditDistribution(root);const version=report.version;
  if(git) {
    const run=(...args)=>{const p=spawnSync('git',args,{cwd:root,encoding:'utf8',shell:false});if(p.status!==0)throw new Error(p.stderr.trim() || `git ${args.join(' ')} failed`);return p.stdout.trim();};
    if(await fsp.realpath(run('rev-parse','--show-toplevel'))!==await fsp.realpath(root))throw new Error('release check requires the standalone repository, not its parent');
    if(run('status','--porcelain'))throw new Error('release tree has uncommitted changes');
    const head=run('rev-parse','HEAD');if(run('rev-parse',`v${version}^{commit}`)!==head)throw new Error('HEAD must have the current version tag');
    if(!run('log','-1','--format=%s').includes(`v${version}`))throw new Error('release commit subject must contain its version');
    const prior=spawnSync('git',['show','HEAD^:package.json'],{cwd:root,encoding:'utf8',shell:false});
    if(prior.status===0 && JSON.parse(prior.stdout).version===version)throw new Error('commit did not change package version');
    return {...report,gitVerified:true,head,tag:`v${version}`};
  }
  return {...report,gitVerified:false};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await checkRelease(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),{git:process.argv.includes('--git')}),null,2));
