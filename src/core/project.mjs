import path from 'node:path';
import fsp from 'node:fs/promises';
import { assertFormat, schema } from './formats.mjs';
import { SessionStore, terminalState } from './session.mjs';
import { loadTemplate, renderTemplate, loadValues, INPUT_PROVENANCE, recordInputBatch } from './template.mjs';
import { deepMerge, pathExists, readJson, writeJsonAtomic } from './util.mjs';

export async function discoverProject(start = process.cwd()) {
  let directory=path.resolve(start);
  while (true) {
    const file=path.join(directory,'.workspace-recover','project.json');
    if(await pathExists(file)) {
      const document=assertFormat(await readJson(file),'project');
      if(typeof document.template!=='string' || !Array.isArray(document.values) || document.values.some(x=>typeof x!=='string'))throw new Error('invalid project configuration');
      return {root:directory,directory:path.dirname(file),file,document};
    }
    const parent=path.dirname(directory);if(parent===directory)return null;directory=parent;
  }
}

export async function projectValues(project, options = {}) {
  const files=project.document.values.map(p=>path.resolve(project.directory,p));
  const supplied=await loadValues([...files,...(options.values || [])],options.set || [],options.setJson || []);
  const values=deepMerge(project.document.defaults || {},supplied);
  if(values.sourcePath===undefined || values.sourcePath===null)values.sourcePath=project.root;
  const provenance=structuredClone(supplied[INPUT_PROVENANCE] || {});
  if(supplied.sourcePath===undefined || supplied.sourcePath===null)provenance.sourcePath=[{source:'project-root',value:project.root}];
  Object.defineProperty(values,INPUT_PROVENANCE,{value:provenance});
  return values;
}

export async function startProjectInit({templatePath,projectRoot=process.cwd(),values={},stateRoot}) {
  const store=new SessionStore(stateRoot || undefined);
  const root=path.resolve(projectRoot);
  const session=await store.create('init',{projectRoot:root,inputs:values,inputProvenance:values[INPUT_PROVENANCE] || {}});
  return store.attempt(session,async()=>{
    if(await pathExists(path.join(root,'.workspace-recover')))throw new Error('project configuration already exists; init never overwrites it');
    if(!(await fsp.stat(root)).isDirectory())throw new Error('project root must be an existing directory');
    const template=await loadTemplate(templatePath);
    await store.write(session.id,'template.json',template);
    const inputs=deepMerge({projectName:path.basename(root),sourcePath:root},values);
    if(inputs.projectName==null)inputs.projectName=path.basename(root);
    if(inputs.sourcePath==null)inputs.sourcePath=root;
    await store.write(session.id,'values.json',{schema:schema('values'),values:inputs});
    return resolveInit(store,session,template,inputs);
  });
}
export async function continueProjectInit(store,session,values={}) {
  if(terminalState(session.state))return session;
  return store.attempt(session,async()=>{
    const template=assertFormat(await readJson(path.join(store.directory(session.id),'template.json')),'template');
    const saved=assertFormat(await readJson(path.join(store.directory(session.id),'values.json')),'values').values;
    for(const [k,v] of Object.entries(values[INPUT_PROVENANCE] || {}))(session.inputProvenance[k]??=[]).push(...v);
    return resolveInit(store,session,template,deepMerge(saved,values));
  });
}
async function resolveInit(store,session,template,values) {
  const rendered=await renderTemplate(template,values,session.inputProvenance);
  if(rendered.missing.length || rendered.errors.length)return recordInputBatch(store,session,template,rendered);
  const root=session.projectRoot;
  const configDir=path.join(root,'.workspace-recover');
  // Claim only our new configuration directory; never overwrite an authored one.
  await fsp.mkdir(configDir);
  await writeJsonAtomic(path.join(configDir,'template.json'),template,0o644);
  const local=structuredClone(rendered.values);
  const defaults={projectName:local.projectName};delete local.projectName;
  // The common current-directory source binds after relocation, not to this machine.
  if(path.resolve(local.sourcePath)===root)delete local.sourcePath;
  await writeJsonAtomic(path.join(configDir,'values.local.json'),{schema:schema('values'),values:local});
  await writeJsonAtomic(path.join(configDir,'values.example.json'),{schema:schema('values'),values:{}},0o644);
  await fsp.writeFile(path.join(configDir,'.gitignore'),'values.local.json\n',{mode:0o644});
  const config={schema:schema('project'),template:'template.json',values:['values.local.json'],defaults};
  await writeJsonAtomic(path.join(configDir,'project.json'),config,0o644);
  const fullPath=await store.write(session.id,'init-receipt.json',{schema:schema('init-receipt'),projectRoot:root,configuration:path.join(configDir,'project.json'),inputProvenance:rendered.provenance});
  session.result={configuration:'created',project:root};session.state='completed';
  session.next={type:'automatic',action:'backup',command:'workspace-recover backup'};
  await store.setInfo(session,'init',{short:`Project configuration created: ${root}`,medium:`Configuration: ${path.join(configDir,'project.json')}\nLocal values: ${path.join(configDir,'values.local.json')}\nNext operation: backup`,fullPath});
  await store.save(session);await store.remember(session.id,root);return session;
}
