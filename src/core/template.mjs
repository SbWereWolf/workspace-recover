import path from 'node:path';
import fsp from 'node:fs/promises';
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
  if (template.schema !== 'workspace-recover/template/v1') throw new Error(`unsupported template schema in ${templatePath}`);
  return template;
}

export async function renderTemplate(template, suppliedValues = {}) {
  const base = collectInputDefaults(template);
  const values = resolveDerivedInputs(template, deepMerge(base, suppliedValues));
  const requiredMissing = [];
  for (const [key, definition] of Object.entries(template.inputs || {})) {
    const value = getByPath(values, key);
    if (definition.required && value === undefined) requiredMissing.push(key);
    if (value !== undefined && definition.type) {
      const matches = {
        string: typeof value === 'string',
        number: typeof value === 'number' && Number.isFinite(value),
        integer: Number.isSafeInteger(value),
        boolean: typeof value === 'boolean',
        array: Array.isArray(value),
        object: value !== null && typeof value === 'object' && !Array.isArray(value),
      };
      if (matches[definition.type] !== true) throw new Error(`template input ${key} must be ${definition.type}`);
    }
  }
  // Runtime workflow locations must be bound in the actual restored workspace,
  // never captured from the backup author's machine during template rendering.
  const authorManifest = structuredClone(template.manifest);
  const workflow = authorManifest.restore?.workflow;
  if (workflow !== undefined) delete authorManifest.restore.workflow;
  const rendered = renderValue(authorManifest, values, { allowMissing: true });
  if (workflow !== undefined) {
    const runtime = renderValue(workflow, values, { allowMissing: true, deferred: ['workspace', 'stepDir', 'operation'] });
    rendered.value.restore.workflow = runtime.value;
    rendered.missing.push(...runtime.missing);
  }
  const missing = [...new Set([...requiredMissing, ...rendered.missing])].sort();
  return { manifest: rendered.value, values, missing };
}

export async function initializeTemplate({ presetDirectory, outputDirectory, name }) {
  await fsp.mkdir(path.dirname(outputDirectory), { recursive: true });
  try { await fsp.mkdir(outputDirectory); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`template output already exists: ${outputDirectory}`);
    throw error;
  }
  const template = await readJson(path.join(presetDirectory, 'template.json'));
  template.name = name;
  await writeJsonAtomic(path.join(outputDirectory, 'template.json'), template, 0o644);
  const example = {};
  for (const [key, definition] of Object.entries(template.inputs || {})) {
    if (Object.hasOwn(definition, 'example')) setByPath(example, key, definition.example);
    else if (Object.hasOwn(definition, 'default')) setByPath(example, key, definition.default);
    else setByPath(example, key, `<${key}>`);
  }
  await writeJsonAtomic(path.join(outputDirectory, 'values.example.json'), example, 0o644);
  return { templatePath: path.join(outputDirectory, 'template.json'), valuesPath: path.join(outputDirectory, 'values.example.json') };
}

export async function loadValues(valuesFile, setItems = []) {
  const fromFile = valuesFile ? await readJson(valuesFile) : {};
  return deepMerge(fromFile, parseSet(setItems));
}
