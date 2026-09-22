import fsp from 'node:fs/promises';
import path from 'node:path';
import {assertFormat,schema} from './formats.mjs';
import {archiveName} from './tar-format.mjs';

/** POSIX, source-relative glob grammar: *, ?, and whole-segment **. Dotfiles are ordinary names. */
export function validateSelection(includes=['**'],excludes=[]) {
  const parse=(patterns,label)=>{
    if(!Array.isArray(patterns))throw new Error(`${label} patterns must be an array`);
    return patterns.map(pattern=>{
      if(typeof pattern!=='string'||!pattern||pattern.includes('\0')||pattern.startsWith('/')||/^[A-Za-z]:/.test(pattern))throw new Error(`invalid relative selection pattern: ${pattern}`);
      const value=pattern.replace(/^\.\//,'').replace(/\/$/,'');
      const segments=value.split('/');
      if(segments.some(x=>!x||x==='.'||x==='..'||(x.includes('**')&&x!=='**')))throw new Error(`invalid selection pattern: ${pattern}`);
      return {pattern,segments,directoryOnly:pattern.endsWith('/')};
    });
  };
  return {include:parse(includes,'include'),exclude:parse(excludes,'exclude')};
}
function partMatch(pattern,value){return new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'[^/]*').replace(/\?/g,'[^/]')+'$','u').test(value);}
function matchSegments(pattern,parts,prefix=false){
  const cache=new Map();
  function step(i,j){const key=`${i}:${j}`;if(cache.has(key))return cache.get(key);let yes;
    if(j===parts.length)yes=prefix||pattern.slice(i).every(x=>x==='**');
    else if(i===pattern.length)yes=false;
    else if(pattern[i]==='**')yes=step(i+1,j)||step(i,j+1);
    else yes=partMatch(pattern[i],parts[j])&&step(i+1,j+1);
    cache.set(key,yes);return yes;
  }
  return step(0,0);
}
export function matchesGlob(pattern,name,{directory=false}={}){const p=validateSelection([pattern],[]).include[0];return (!p.directoryOnly||directory)&&matchSegments(p.segments,name.split('/'));}
export function fileIdentity(stat){return Object.fromEntries(['dev','ino','size','mtimeMs','ctimeMs'].map(k=>[k,stat[k]]));}
export function sameIdentity(a,b){return ['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);}

export async function selectSource({source,includes=['**'],excludes=[]}) {
  const rules=validateSelection(includes,excludes),sourceRoot=await fsp.realpath(source),chosen=new Map(),allDirectories=new Map(),watched=[];
  const rootStat=await fsp.lstat(sourceRoot);if(!rootStat.isDirectory())throw new Error('backup source must be a directory');
  let visited=0,excluded=0;
  const entry=(absolute,relative,stat,type)=>({absolute,name:relative?(type==='5'?relative+'/':relative):'./',type,mode:stat.mode,size:type==='0'?stat.size:0,mtimeMs:stat.mtimeMs,identity:fileIdentity(stat)});
  async function visit(absolute,relative,inherited=[]) {
    const stat=await fsp.lstat(absolute),directory=stat.isDirectory();visited++;
    const parts=relative?relative.split('/'):[];
    if(relative&&rules.exclude.some(p=>(!p.directoryOnly||directory)&&matchSegments(p.segments,parts))){excluded++;return;}
    const direct=relative?rules.include.filter(p=>(!p.directoryOnly||directory)&&matchSegments(p.segments,parts)).map(p=>p.pattern):[];
    const reasons=[...new Set([...inherited,...direct])];
    if(directory) {
      const e=entry(absolute,relative,stat,'5');allDirectories.set(relative,e);
      if(!relative||reasons.length)chosen.set(relative,{...e,reasons:relative?reasons:['root-metadata']});
      if(relative&&!reasons.length&&!rules.include.some(p=>matchSegments(p.segments,parts,true)))return;
      if(!relative&&!rules.include.length)return;
      watched.push(e);
      const decoder=new TextDecoder('utf-8',{fatal:true});
      const names=(await fsp.readdir(absolute,{encoding:'buffer'})).map(b=>decoder.decode(b)).sort();
      for(const name of names)await visit(path.join(absolute,name),relative?relative+'/'+name:name,reasons);
    } else if(reasons.length) {
      let e;
      if(stat.isFile())e=entry(absolute,relative,stat,'0');
      else if(stat.isSymbolicLink())e={...entry(absolute,relative,stat,'2'),linkname:new TextDecoder('utf-8',{fatal:true}).decode(await fsp.readlink(absolute,{encoding:'buffer'}))};
      else throw new Error(`unsupported selected filesystem entry: ${relative}`);
      chosen.set(relative,{...e,reasons});
    }
  }
  await visit(sourceRoot,'');
  for(const name of [...chosen.keys()]){let parent=path.posix.dirname(name);while(parent!=='.'){if(!chosen.has(parent))chosen.set(parent,{...allDirectories.get(parent),reasons:['parent-metadata']});parent=path.posix.dirname(parent);}}
  const entries=[...chosen].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,e])=>e);
  return {sourceRoot,patterns:{include:includes,exclude:excludes},entries,watched,visited,excluded};
}
export function selectionInventory(selection){
  const entries=selection.entries.map(e=>({path:archiveName(e.name),type:({'0':'file','5':'directory','2':'symlink'})[e.type],mode:e.mode&0o7777,...(e.type==='0'?{bytes:e.size,sha256:e.sha256}:{}),...(e.type==='2'?{target:e.linkname}:{}),reasons:e.reasons}));
  return {schema:schema('selection'),patterns:selection.patterns,totals:{entries:entries.length,files:entries.filter(e=>e.type==='file').length,bytes:entries.reduce((sum,e)=>sum+(e.bytes||0),0),visited:selection.visited,excludedRoots:selection.excluded},entries};
}
export function assertInventory(value){
  assertFormat(value,'selection');if(!Array.isArray(value.entries))throw new Error('inventory entries must be an array');
  const names=new Set();
  for(const e of value.entries){if(!e||typeof e!=='object'||archiveName(e.path)!==e.path||names.has(e.path))throw new Error('unsafe or duplicate inventory path');names.add(e.path);
    if(!['file','directory','symlink'].includes(e.type)||!Number.isInteger(e.mode)||e.mode<0||e.mode>0o7777)throw new Error('invalid inventory entry metadata');
    if(e.type==='file'&&(!Number.isSafeInteger(e.bytes)||e.bytes<0||!/^[a-f0-9]{64}$/.test(e.sha256||'')))throw new Error('invalid inventory file bytes or hash');
    if(e.type==='symlink'&&(typeof e.target!=='string'||e.target.includes('\0')))throw new Error('invalid inventory symlink');
  }
  if(!value.entries.some(e=>e.path==='.'&&e.type==='directory'))throw new Error('inventory requires root directory metadata');
  return value;
}
export function selectionNul(selection){return Buffer.from(selection.entries.map(e=>e.name==='./'?'.':e.name.replace(/\/$/,'')).join('\0')+'\0','utf8');}
