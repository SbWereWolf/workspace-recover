import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadValues, renderTemplate } from '../src/core/template.mjs';
import { startBackup, continueBackup } from '../src/core/backup.mjs';
import { SessionStore } from '../src/core/session.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/workspace-recover.mjs');
const schema = kind => `workspace-recover/${kind}/v3`;
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'wr-batch-test-'));
const put = (p, v) => fsp.writeFile(p, JSON.stringify(v));
const values = v => ({ schema: schema('values'), values: v });
const tpl = (inputs, manifest = {}) => ({ schema: schema('template'), name: 'batch', inputs, manifest: { schema: schema('manifest'), ...manifest } });

test('029: values documents layer deeply, arrays replace, CLI values override', async () => {
  const d = await tmp();
  await put(path.join(d, 'a.json'), values({ a: { b: 1, c: true }, arr: [1,2] }));
  await put(path.join(d, 'b.json'), values({ a: { b: 3 }, arr: [4] }));
  const actual = await loadValues([path.join(d,'a.json'), path.join(d,'b.json')], ['a.b=5'], ['arr=[8,9]']);
  assert.deepEqual(actual, { a: { b: 5, c: true }, arr: [8,9] });
});
test('029: unversioned and other-version values are rejected', async () => {
  const d=await tmp(); const p=path.join(d,'v.json');
  for (const doc of [{a:1}, {schema:'workspace-recover/values/v1',values:{}}, {schema:'workspace-recover/values/v999',values:{}}]) {
    await put(p,doc); await assert.rejects(loadValues(p), /schema|format/i);
  }
});
test('029: all missing and invalid typed fields returned as one batch', async () => {
  const result=await renderTemplate(tpl({a:{type:'path',required:true},b:{type:'email',required:true}, c:{type:'integer',required:true}}),{b:'not-an-email',c:'three'});
  assert.deepEqual(result.missing,['a']); assert.equal(result.errors.length,2);
  assert.deepEqual(result.errors.map(x=>x.key),['b','c']);
});
test('029: typed enum, URL, path, array and derived defaults preserve values', async () => {
  const result=await renderTemplate(tpl({ p:{type:'path',required:true}, mail:{type:'email'}, n:{type:'integer',default:4}, u:{type:'url'}, e:{type:'enum',enum:['a','b']}, a:{type:'array'}, derived:{type:'string',derive:'${p}/data'}}),{p:'/work',mail:'test@example.com',u:'https://example.com',e:'b',a:[1]});
  assert.deepEqual(result.errors,[]); assert.deepEqual(result.missing,[]); assert.equal(result.values.derived,'/work/data');
});
test('029: missing batch stored as a supplied-file template; next JSON points to it', async () => {
  const d=await tmp(); const p=path.join(d,'template.json');
  await put(p,tpl({ a:{type:'string',required:true}, b:{type:'boolean',required:true}, c:{type:'integer',required:true}}));
  const s=await startBackup({templatePath:p,values:{},stateRoot:path.join(d,'state')});
  assert.equal(s.state,'waiting_for_input'); assert.equal(s.next.required.length,3);
  const form=JSON.parse(await fsp.readFile(s.next.valuesFile,'utf8'));
  assert.equal(form.schema,schema('values')); assert.deepEqual(form.values,{a:null,b:null,c:null});
  const out=spawnSync(process.execPath,[CLI,'next',s.id,'--json','--state-dir',path.join(d,'state')],{encoding:'utf8'});
  assert.equal(out.status,0,out.stderr); assert.equal(JSON.parse(out.stdout).next.valuesFile,s.next.valuesFile);
});
test('029: supplied placeholder null is missing, unknown input is a reported error', async () => {
  const r=await renderTemplate(tpl({one:{type:'string',required:true}}),{one:null,typo:3});
  assert.deepEqual(r.missing,['one']); assert.match(r.errors[0].message,/unknown/);
});
test('029: declared sensitive paths cannot pollute Object.prototype', async () => {
  await assert.rejects(loadValues(null,['__proto__.polluted=yes']), /unsafe|reserved/i);
  await assert.rejects(loadValues(null,[],['constructor.prototype.bad=true']), /unsafe|reserved/i);
  assert.equal({}.polluted,undefined); assert.equal({}.bad,undefined);
});
test('029: describe and bundled values are available without runtime discovery', async () => {
  for (const name of ['local-project','google-workspace-project']) {
    const example=JSON.parse(await fsp.readFile(path.join(ROOT,'templates',name,'values.example.json'),'utf8'));
    assert.equal(example.schema,schema('values')); assert.ok(example.values);
    const out=spawnSync(process.execPath,[CLI,'template','describe',name,'--format','json'],{encoding:'utf8'});
    assert.equal(out.status,0,out.stderr); assert.equal(JSON.parse(out.stdout).schema,schema('input-requirements'));
  }
});
test('029: input origin and overrides are recorded in the frozen backup plan', async () => {
  const d=await tmp(); const src=path.join(d,'src');await fsp.mkdir(src);await fsp.writeFile(path.join(src,'a'),'a');
  const v=path.join(d,'values.json'); await put(v,values({projectName:'test',sourcePath:src,backupRoot:path.join(d,'backups')}));
  const out=spawnSync(process.execPath,[CLI,'backup','local-project','--values',v,'--set','partSizeBytes=2048','--non-interactive','--state-dir',path.join(d,'state')],{encoding:'utf8'});
  assert.equal(out.status,0,out.stderr); const id=out.stdout.match(/Session: (\S+)/)?.[1];assert.ok(id);
  const s=await new SessionStore(path.join(d,'state')).load(id); const plan=JSON.parse(await fsp.readFile(s.planPath));
  assert.ok(plan.inputProvenance.sourcePath.some(x=>x.source.includes('values.json')));
  assert.ok(plan.inputProvenance.partSizeBytes.some(x=>x.source.includes('--set')));
});
test('029: a single continue supplies the entire missing batch', async () => {
  const d=await tmp(); const src=path.join(d,'src');await fsp.mkdir(src);await fsp.writeFile(path.join(src,'a'),'ok');
  const template=path.join(ROOT,'templates/local-project/template.json');
  const s=await startBackup({templatePath:template,values:{},stateRoot:path.join(d,'state')});
  assert.equal(s.next.required.length,3);
  await put(s.next.valuesFile,values({projectName:'all-at-once',sourcePath:src,backupRoot:path.join(d,'backups')}));
  const proc=spawnSync(process.execPath,[CLI,'continue',s.id,'--values',s.next.valuesFile,'--state-dir',path.join(d,'state'),'--non-interactive'],{encoding:'utf8'});
  assert.equal(proc.status,0,proc.stderr); assert.match(proc.stdout,/State: completed/);
  assert.match(proc.stdout,new RegExp(s.id));
});
test('029: interactive mode edits one complete form rather than sequential questions', async () => {
  const d=await tmp(); const src=path.join(d,'src');await fsp.mkdir(src);await fsp.writeFile(path.join(src,'a'),'ok');
  const editor=path.join(d,'editor');const count=path.join(d,'count');
  await fsp.writeFile(editor,`#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(count)},'1');const f=JSON.parse(fs.readFileSync(process.argv[2]));if(Object.keys(f.values).length!==3)process.exit(3);f.values=${JSON.stringify({projectName:'human',sourcePath:src,backupRoot:path.join(d,'backups')})};fs.writeFileSync(process.argv[2],JSON.stringify(f));\n`,{mode:0o755});
  const proc=spawnSync(process.execPath,[CLI,'backup','local-project','--interactive','--editor',editor,'--state-dir',path.join(d,'state')],{encoding:'utf8'});
  assert.equal(proc.status,0,proc.stderr);assert.equal(await fsp.readFile(count,'utf8'),'1');
});
test('029: supplying values cannot overwrite a frozen plan waiting for authentication', async () => {
  const d=await tmp(); const store=new SessionStore(path.join(d,'state'));
  const s=await store.create('backup',{state:'waiting_for_auth',planFrozen:true});
  await assert.rejects(continueBackup(store,s,{projectName:'changed'}),/frozen plan/);
});
