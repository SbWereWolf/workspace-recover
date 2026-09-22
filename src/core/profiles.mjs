import path from 'node:path';
import fsp from 'node:fs/promises';
import { assertFormat, schema } from './formats.mjs';
import { homeConfigDir, pathExists, readJson, writeJsonAtomic } from './util.mjs';

export function profileName(value) {
  if(typeof value!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) || ['constructor','prototype'].includes(value))throw new Error('invalid local profile name');
  return value;
}
export function validateLocalProfile(document) {
  assertFormat(document,'profile');
  if(document.name!==undefined)profileName(document.name);
  const allowed=new Set(['schema','name','workspaceRoot','googleProfile']);
  const errors=Object.keys(document).filter(k=>!allowed.has(k)).map(k=>`unknown profile field: ${k}`);
  if(document.workspaceRoot!==undefined && (typeof document.workspaceRoot!=='string' || !document.workspaceRoot || !path.isAbsolute(document.workspaceRoot) || document.workspaceRoot.includes('\0')))errors.push('workspaceRoot must be an absolute local path');
  if(document.googleProfile!==undefined){try{profileName(document.googleProfile);}catch(e){errors.push(e.message);}}
  if(errors.length)throw new Error(errors.join('; '));return document;
}
export async function loadLocalProfile(name='default',{optional=false}={}) {
  const file=path.join(homeConfigDir(),'profiles',`${profileName(name)}.json`);
  if(!await pathExists(file)){if(optional)return null;throw new Error(`Local profile missing: ${file}. Copy the bundled templates/profile.values.example.json, fill it and run profile create ${name} --values FILE.`);}
  return validateLocalProfile(await readJson(file));
}
export async function createLocalProfile(name,values) {
  profileName(name);
  const unknown=Object.keys(values).filter(k=>!['workspaceRoot','googleProfile'].includes(k));
  if(unknown.length)throw new Error(`unknown profile value(s): ${unknown.join(', ')}`);
  const document=validateLocalProfile({schema:schema('profile'),name,...values});
  const file=path.join(homeConfigDir(),'profiles',`${name}.json`);
  await fsp.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  await fsp.writeFile(file,JSON.stringify(document,null,2)+'\n',{flag:'wx',mode:0o600});return {file,document};
}
export async function listLocalProfiles() {
  const root=path.join(homeConfigDir(),'profiles');if(!await pathExists(root))return [];
  return (await fsp.readdir(root)).filter(n=>n.endsWith('.json')).map(n=>n.slice(0,-5)).sort();
}
export function targetFromProfile(recovery,profile) {
  if(!profile?.workspaceRoot)return null;
  const name=recovery.project?.name;
  if(name===undefined)return null;
  if(typeof name!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))throw new Error('unsafe project name for inferred target');
  return path.join(profile.workspaceRoot,name);
}
