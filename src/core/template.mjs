import {PROFILE_PLACEHOLDERS} from './archive-profile.mjs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { assertFormat, schema } from './formats.mjs';
import { deepMerge, getByPath, parseSet, readJson, setByPath, writeJsonAtomic } from './util.mjs';

const FULL_PLACEHOLDER = /^\$\{([A-Za-z0-9_.-]+)\}$/;
const ANY_PLACEHOLDER = /\$\{([A-Za-z0-9_.-]+)\}/g;

export function collectInputDefaults(template) {
  const values = {};
  for (const [key, definition] of Object.entries(template.inputs || {})) {
    if (Object.hasOwn(definition, 'default')) setByPath(values, key, structuredClone(definition.default));
  }
  return values;
}

export function resolveDerivedInputs(template, values) {
  const result = structuredClone(values);
  for (let round = 0; round < 20; round += 1) {
    let changed = false;
    for (const [key, definition] of Object.entries(template.inputs || {})) {
      if (!definition?.derive || getByPath(result, key) !== undefined) continue;
      const rendered = renderValue(definition.derive, result, { allowMissing: true });
      if (rendered.missing.length === 0) {
        setByPath(result, key, rendered.value);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result;
}

export function renderValue(value, values, { allowMissing = false, deferred = [] } = {}) {
  const missing = new Set();
  const reserved = new Set(deferred);
  const render = current => {
    if (Array.isArray(current)) return current.map(render);
    if (current && typeof current === 'object') {
      return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, render(item)]));
    }
    if (typeof current !== 'string') return current;
    const full = current.match(FULL_PLACEHOLDER);
    if (full) {
      if (reserved.has(full[1])) return current;
      const found = getByPath(values, full[1]);
      if (found === undefined) {
        missing.add(full[1]);
        return current;
      }
      return structuredClone(found);
    }
    return current.replace(ANY_PLACEHOLDER, (_, key) => {
      if (reserved.has(key)) return `\${${key}}`;
      const found = getByPath(values, key);
      if (found === undefined) {
        missing.add(key);
        return `\${${key}}`;
      }
      return String(found);
    });
  };
  const rendered = render(value);
  if (missing.size > 0 && !allowMissing) return { value: rendered, missing: [...missing].sort() };
  return { value: rendered, missing: [...missing].sort() };
}

export async function loadTemplate(templatePath) {
  const template = await readJson(templatePath);
  assertFormat(template, 'template');
  return template;
}

export const INPUT_PROVENANCE = Symbol.for('workspace-recover.input-provenance');
const TYPES = new Set(['string','number','integer','boolean','array','object','path','email','url','enum','google-drive-folder']);
function inputMatches(definition, value) {
  if (value === null) return definition.nullable === true;
  switch (definition.type || 'string') {
    case 'string': return typeof value === 'string';
    case 'path': return typeof value === 'string' && value.length > 0 && !value.includes('\0');
    case 'email': return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'url': try { return ['https:', 'http:', 'file:'].includes(new URL(value).protocol); } catch { return false; }
    case 'google-drive-folder': return typeof value === 'string' && (/^[A-Za-z0-9_-]+$/.test(value) || /^https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+(?:[/?#].*)?$/.test(value));
    case 'integer': return Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'enum': return Array.isArray(definition.enum) && definition.enum.some(v => JSON.stringify(v) === JSON.stringify(value));
    default: return false;
  }
}
function leafEntries(object, prefix = '') {
  const result=[];
  for (const [key,value] of Object.entries(object)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    // Reject dangerous keys even when the entire nested value replaces a default.
    getByPath({}, dotted);
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) result.push(...leafEntries(value,dotted));
    else result.push([dotted,value]);
  }
  return result;
}
export function describeInputs(template) {
  assertFormat(template, 'template');
  return { schema: schema('input-requirements'), template: template.name, inputs: template.inputs || {} };
}
export async function renderTemplate(template, suppliedValues = {}, suppliedProvenance = null) {
  assertFormat(template, 'template');
  const base = collectInputDefaults(template);
  const values = resolveDerivedInputs(template, deepMerge(base, suppliedValues));
  const requiredMissing = [], errors = [], provenance = {};
  for (const [key, definition] of Object.entries(template.inputs || {})) {
    if (definition.type && !TYPES.has(definition.type)) throw new Error(`unsupported input type: ${definition.type}`);
    const value = getByPath(values, key);
    if (definition.required && (value === undefined || value === null || value === '')) requiredMissing.push(key);
    else if (value !== undefined && !inputMatches(definition, value)) errors.push({key,message:`template input ${key} must be ${definition.type || 'string'}`});
    provenance[key] = [];
    if (Object.hasOwn(definition,'default')) provenance[key].push({source:'default',value:definition.default});
    const supplied = suppliedProvenance || suppliedValues[INPUT_PROVENANCE] || {};
    const origins = Object.entries(supplied).filter(([p]) => p === key || p.startsWith(key+'.') || key.startsWith(p+'.')).flatMap(([,v])=>v);
    if (origins.length) provenance[key].push(...origins);
    else if (getByPath(suppliedValues,key) !== undefined) provenance[key].push({source:'supplied',value:getByPath(suppliedValues,key)});
    else if (definition.derive && value !== undefined) provenance[key].push({source:'derived',expression:definition.derive,value});
  }
  const declared=Object.keys(template.inputs || {});
  for (const [key] of leafEntries(suppliedValues)) {
    if (!declared.some(d=>key===d || key.startsWith(d+'.') || d.startsWith(key+'.'))) errors.push({key,message:`unknown template input: ${key}`});
  }
  // Workspace/step locations are late-bound by the executor, never by the operator.
  const authorManifest=structuredClone(template.manifest);
  const declarations={actions:authorManifest.actions,reporters:authorManifest.reporters};
  delete authorManifest.actions;delete authorManifest.reporters;
  const workflow=authorManifest.restore?.workflow;
  if (workflow!==undefined) delete authorManifest.restore.workflow;
  const archiveProfile=authorManifest.archiveProfile;delete authorManifest.archiveProfile;
  const rendered=renderValue(authorManifest,values,{allowMissing:true});
  if(archiveProfile!==undefined){const deferred=[...PROFILE_PLACEHOLDERS,...(archiveProfile.bootstrap||[]).map(b=>'bootstrap.'+b.id)];const r=renderValue(archiveProfile,values,{allowMissing:true,deferred});rendered.value.archiveProfile=r.value;rendered.missing.push(...r.missing);}
  if (workflow!==undefined) {
    const runtime=renderValue(workflow,values,{allowMissing:true,deferred:['workspace','stepDir','operation']});
    rendered.value.restore.workflow=runtime.value;rendered.missing.push(...runtime.missing);
  }
  for(const [k,v] of Object.entries(declarations))if(v!==undefined){const late=renderValue(v,values,{allowMissing:true,deferred:['workspace','stepDir','operation']});rendered.value[k]=late.value;rendered.missing.push(...late.missing);}
  const missing=[...new Set([...requiredMissing,...rendered.missing])].sort();
  return {manifest:rendered.value,values,missing,errors,provenance};
}

export async function recordInputBatch(store, session, template, rendered) {
  const needs=[...new Set([...rendered.missing,...rendered.errors.map(e=>e.key)])];
  const form={}; for (const key of needs) setByPath(form,key,getByPath(rendered.values,key) ?? null);
  const valuesFile=await store.write(session.id,'missing-values.json',{schema:schema('values'),values:form});
  const requirementsFile=await store.write(session.id,'input-requirements.json',{
    ...describeInputs(template),missing:rendered.missing,errors:rendered.errors,valuesFile,
  });
  session.state='waiting_for_input';
  session.next={type:'manual',action:'provide-input',required:rendered.missing,errors:rendered.errors,valuesFile,requirementsFile,
    command:`workspace-recover continue ${session.id} --values ${JSON.stringify(valuesFile)}`};
  session.inputProvenance=rendered.provenance;
  await store.write(session.id,'values.json',{schema:schema('values'),values:rendered.values});
  await store.save(session);return session;
}

export async function initializeTemplate({ presetDirectory, outputDirectory, name }) {
  const template = assertFormat(await readJson(path.join(presetDirectory, 'template.json')), 'template');
  await fsp.mkdir(path.dirname(outputDirectory), { recursive: true });
  try { await fsp.mkdir(outputDirectory); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`template output already exists: ${outputDirectory}`);
    throw error;
  }
  template.name = name;
  await writeJsonAtomic(path.join(outputDirectory, 'template.json'), template, 0o644);
  const example = {};
  for (const [key, definition] of Object.entries(template.inputs || {})) {
    setByPath(example, key, Object.hasOwn(definition,'default') ? definition.default : null);
  }
  await writeJsonAtomic(path.join(outputDirectory, 'values.example.json'), {schema:schema('values'),values:example}, 0o644);
  return { templatePath: path.join(outputDirectory, 'template.json'), valuesPath: path.join(outputDirectory, 'values.example.json') };
}

export async function loadValues(valuesFiles, setItems = [], jsonItems = []) {
  let result = {}; const provenance = {};
  const layers=[];
  for (const file of (Array.isArray(valuesFiles) ? valuesFiles : valuesFiles ? [valuesFiles] : [])) {
    const doc=assertFormat(await readJson(file),'values');
    if (!doc.values || typeof doc.values!=='object' || Array.isArray(doc.values)) throw new Error('values document requires an object values');
    layers.push({source:`values:${path.resolve(file)}`,value:doc.values});
  }
  for (const item of setItems) layers.push({source:'--set',value:parseSet([item])});
  for (const item of jsonItems) {
    const at=item.indexOf('=');if(at<1)throw new Error('--set-json requires key=JSON');
    const value={};setByPath(value,item.slice(0,at),JSON.parse(item.slice(at+1)));
    layers.push({source:'--set-json',value});
  }
  for (const layer of layers) {
    for (const [key,value] of leafEntries(layer.value)) (provenance[key]??=[]).push({source:layer.source,value});
    result=deepMerge(result,layer.value);
  }
  Object.defineProperty(result,INPUT_PROVENANCE,{value:provenance,enumerable:false});
  return result;
}
