import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMAT_VERSION } from '../src/core/formats.mjs';

/** Distribution checks are local, deterministic, and do not contact providers. */
export async function auditDistribution(root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')) {
  let markdown=0,links=0,json=0,modules=0;const errors=[];
  async function walk(dir) {
    for(const entry of await fsp.readdir(dir,{withFileTypes:true})) {
      if(['.git','node_modules'].includes(entry.name))continue;
      const file=path.join(dir,entry.name);if(entry.isDirectory()){await walk(file);continue;}if(!entry.isFile())continue;
      if(file.endsWith('.json')) {
        json++;let value;try{value=JSON.parse(await fsp.readFile(file,'utf8'));}catch(e){errors.push(`${file}: ${e.message}`);continue;}
        if(value.schema?.startsWith('workspace-recover/') && !value.schema.endsWith(`/v${FORMAT_VERSION}`))errors.push(`noncurrent format: ${file}`);
        if(file.includes(`${path.sep}schemas${path.sep}`) && !value.$id?.endsWith(`/v${FORMAT_VERSION}`))errors.push(`noncurrent schema ID: ${file}`);
      }
      if(file.endsWith('.md')) {
        markdown++;const text=await fsp.readFile(file,'utf8');
        for(const m of text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
          const ref=m[1].split(/\s+"/)[0];if(/^[a-z]+:|^#/i.test(ref) || ref.includes('<'))continue;
          const target=decodeURIComponent(ref.split('#')[0]);if(!target)continue;links++;
          if(!await fsp.stat(path.resolve(path.dirname(file),target)).catch(()=>null))errors.push(`broken link in ${file}: ${ref}`);
        }
      }
      if(file.endsWith('.mjs') && file.includes(`${path.sep}src${path.sep}`)) {
        modules++;const text=await fsp.readFile(file,'utf8');
        for(const m of text.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)) {
          const spec=m[2];if(spec.startsWith('node:'))continue;
          const resolved=path.resolve(path.dirname(file),spec);
          if(!spec.startsWith('.') || path.relative(root,resolved).startsWith('..'))errors.push(`nonstandalone import: ${file}: ${spec}`);
        }
      }
    }
  }
  await walk(root);
  const pkg=JSON.parse(await fsp.readFile(path.join(root,'package.json'),'utf8'));
  if(!/^\d+\.\d+\.\d+$/.test(pkg.version))errors.push('invalid package release version');
  const changelog=await fsp.readFile(path.join(root,'CHANGELOG.md'),'utf8');if(!changelog.includes(`## ${pkg.version} `))errors.push('current release is absent from CHANGELOG');
  const readme=await fsp.readFile(path.join(root,'README.md'),'utf8');if(!readme.includes('skills/workspace-recover/SKILL.md'))errors.push('README must link its skill');
  if(errors.length)throw new Error(errors.join('\n'));
  return {schema:'workspace-recover/distribution-audit/v3',version:pkg.version,markdown,links,json,modules,errors:[]};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await auditDistribution(),null,2));
