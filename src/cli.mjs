import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { authorizeGoogleWorkspace, googleAuthStatus } from './providers/google-workspace.mjs';
import { initializeTemplate, loadTemplate, loadValues, renderTemplate, describeInputs } from './core/template.mjs';
import { startBackup, startBackupFromManifest, continueBackup } from './core/backup.mjs';
import { startRestore, startRestoreFromManifest, continueRestore } from './core/restore.mjs';
import { SessionStore } from './core/session.mjs';
import { homeConfigDir, parseSet, pathExists, writeJsonAtomic } from './core/util.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function resolveTemplateReference(reference) {
  const direct = path.resolve(reference);
  if (await pathExists(direct)) return direct;
  const candidates = [
    path.join(homeConfigDir(), 'templates', reference, 'template.json'),
    path.join(homeConfigDir(), 'templates', `${reference}.json`),
    path.join(APP_ROOT, 'templates', reference, 'template.json'),
  ];
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  throw new Error(`template not found by name or path: ${reference}`);
}

async function listTemplates() {
  const result = new Set();
  for (const root of [path.join(APP_ROOT, 'templates'), path.join(homeConfigDir(), 'templates')]) {
    if (!await pathExists(root)) continue;
    for (const item of await fsp.readdir(root, { withFileTypes: true })) {
      if (item.isDirectory() && await pathExists(path.join(root, item.name, 'template.json'))) result.add(item.name);
    }
  }
  return [...result].sort();
}

function parseArgs(argv) {
  const positional=[], options={};
  const flags=new Set(['no-browser','non-interactive','interactive','json','short','full']);
  const multiple=new Set(['values','set','set-json']);
  const allowed=new Set(['state-dir','output','preset','target','google-profile','drive-folder','handoff','manifest','view','type','profile','client','format','editor', ...multiple]);
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(!arg.startsWith('--')){positional.push(arg);continue;}
    const eq=arg.indexOf('=');const key=arg.slice(2,eq<0?undefined:eq);
    const name=key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
    if(flags.has(key)){if(eq>=0)throw new Error(`--${key} is a flag`);options[name]=true;continue;}
    if(!allowed.has(key))throw new Error(`unknown option --${key}`);
    const value=eq>=0?arg.slice(eq+1):argv[++i];
    if(value===undefined || value.startsWith('--'))throw new Error(`missing value for --${key}`);
    if(multiple.has(key))(options[name]??=[]).push(value);
    else {if(Object.hasOwn(options,name))throw new Error(`duplicate --${key}`);options[name]=value;}
  }
  if(options.interactive && options.nonInteractive)throw new Error('--interactive conflicts with --non-interactive');
  return {positional,options};
}

async function maybeEditBatch(session, options) {
  if (!options.interactive || session.state !== 'waiting_for_input' || !session.next?.valuesFile) return session;
  const editor = options.editor || process.env.VISUAL || process.env.EDITOR;
  if (!editor) { process.stderr.write('Set EDITOR to an executable, or pass --editor PATH. The complete values form is preserved.\n');return session; }
  // The human edits one form. No shell, sequential questions, or implicit command execution.
  const edited=spawnSync(editor,[session.next.valuesFile],{shell:false,stdio:'inherit'});
  if(edited.error)throw edited.error;
  if(edited.status!==0)return session;
  const values=await loadValues(session.next.valuesFile);
  const store=new SessionStore(options.stateDir || undefined);
  return session.operation==='backup' ? continueBackup(store,session,values) : continueRestore(store,session,values);
}

function usage() {
  return `workspace-recover

Commands:
  template init <name> --preset <preset> [--output <dir>]
  template list
  template describe <name> --format json
  template render <template-name|template.json> [--values values.json ...] [--set key=value ...] [--set-json key=JSON ...] [--non-interactive|--interactive] --output <manifest.json>
  backup <template-name|template.json|manifest.json> [--values values.json ...] [--set key=value ...] [--set-json key=JSON ...] [--non-interactive|--interactive] [--state-dir <dir>]
  restore (--handoff <gmail-url|local-handoff-dir> | --manifest <recovery.json>) [--target <dir>] [--google-profile <name>] [--drive-folder <id|url>] [--state-dir <dir>]
  continue <session-id> [--values values.json ...] [--set key=value] [--state-dir <dir>]
  status <session-id> [--state-dir <dir>]
  next <session-id> [--state-dir <dir>]
  info <session-id> [--type <type>] [--view short|medium|full] [--state-dir <dir>]
  auth google-workspace --client <oauth-client.json> [--profile default] [--no-browser]
  auth status [--profile default]
`;
}

export function printSession(session, options = {}) {
  const quote = value => /[^A-Za-z0-9_./:-]/.test(value) ? `'${value.replaceAll("'", "'\\''")}'` : value;
  const stateArg = options.stateDir ? ` --state-dir ${quote(path.resolve(options.stateDir))}` : '';
  process.stdout.write(`State: ${session.state}\n`);
  if (session.result) {
    for (const [key, value] of Object.entries(session.result)) process.stdout.write(`${key}: ${value}\n`);
  }
  if (session.next && session.next.type !== 'none') {
    process.stdout.write(`Next: ${session.next.command || session.next.action}${session.next.command ? stateArg : ''}\n`);
    if (session.next.required?.length) process.stdout.write(`Missing: ${session.next.required.join(', ')}\n`);
    if (session.next.errors?.length) process.stdout.write(`Invalid: ${session.next.errors.map(e=>e.message).join('; ')}\n`);
    if (session.next.reason) process.stdout.write(`Reason: ${session.next.reason}\n`);
  } else if (session.next?.type === 'none') {
    process.stdout.write('Next: none\n');
  }
  process.stdout.write(`Session: ${session.id}\n`);
  process.stdout.write(`More: workspace-recover info ${session.id}${stateArg}\n`);
}

async function commandTemplate(args) {
  const action = args.positional[1];
  if (action === 'init') {
    const name = args.positional[2];
    if (!name || !args.options.preset) throw new Error('template init requires <name> --preset <preset>');
    const presetDirectory = path.join(APP_ROOT, 'templates', args.options.preset);
    const outputDirectory = args.options.output ? path.resolve(args.options.output) : path.join(homeConfigDir(), 'templates', name);
    const result = await initializeTemplate({ presetDirectory, outputDirectory, name });
    process.stdout.write(`Template: ${result.templatePath}\nValues example: ${result.valuesPath}\n`);
    return 0;
  }
  if (action === 'list') {
    for (const name of await listTemplates()) process.stdout.write(`${name}\n`);
    return 0;
  }
  if (action === 'describe') {
    const reference=args.positional[2];if(!reference)throw new Error('template describe requires name or path');
    const template=await loadTemplate(await resolveTemplateReference(reference));
    process.stdout.write(`${JSON.stringify(describeInputs(template),null,2)}\n`);return 0;
  }
  if (action === 'render') {
    const templateRef = args.positional[2];
    if (!templateRef || !args.options.output) throw new Error('template render requires <template-name|template.json> --output <manifest.json>');
    const templatePath = await resolveTemplateReference(templateRef);
    const template = await loadTemplate(templatePath);
    const values = await loadValues(args.options.values, args.options.set || [], args.options.setJson || []);
    const rendered = await renderTemplate(template, values);
    if (rendered.missing.length || rendered.errors.length) throw new Error(JSON.stringify({missing:rendered.missing,errors:rendered.errors}));
    await writeJsonAtomic(path.resolve(args.options.output), rendered.manifest, 0o644);
    process.stdout.write(`Manifest: ${path.resolve(args.options.output)}\n`);
    return 0;
  }
  throw new Error('unknown template action');
}

async function commandBackup(args) {
  const templateRef = args.positional[1];
  if (!templateRef) throw new Error('backup requires a template name, template.json, or manifest.json');
  let session;
  const direct = path.resolve(templateRef);
  if (await pathExists(direct)) {
    const document = JSON.parse(await fsp.readFile(direct, 'utf8'));
    if (document.schema === 'workspace-recover/manifest/v2') {
      if (args.options.values || (args.options.set || []).length || (args.options.setJson || []).length) throw new Error('--values/--set are for templates; a rendered manifest is already complete');
      session = await startBackupFromManifest({ manifestPath: direct, stateRoot: args.options.stateDir });
    } else {
      const values = await loadValues(args.options.values, args.options.set || [], args.options.setJson || []);
      session = await startBackup({ templatePath: direct, values, stateRoot: args.options.stateDir });
    }
  } else {
    const templatePath = await resolveTemplateReference(templateRef);
    const values = await loadValues(args.options.values, args.options.set || [], args.options.setJson || []);
    session = await startBackup({ templatePath, values, stateRoot: args.options.stateDir });
  }
  session=await maybeEditBatch(session,args.options);
  printSession(session, args.options);
  return session.state === 'failed' ? 1 : session.state.startsWith('waiting_') ? 2 : 0;
}

async function commandRestore(args) {
  if (Boolean(args.options.handoff) === Boolean(args.options.manifest)) throw new Error('restore requires exactly one of --handoff or --manifest');
  const start = args.options.manifest ? startRestoreFromManifest : startRestore;
  const session = await start({
    manifestPath: args.options.manifest,
    handoff: args.options.handoff,
    target: args.options.target || null,
    googleProfile: args.options.googleProfile || 'default',
    expectedDriveFolder: args.options.driveFolder || null,
    stateRoot: args.options.stateDir,
  });
  printSession(session, args.options);
  return session.state === 'failed' ? 1 : 0;
}

async function commandContinue(args) {
  const id = args.positional[1];
  if (!id) throw new Error('continue requires session ID');
  const store = new SessionStore(args.options.stateDir || undefined);
  const session = await store.load(id);
  const values = await loadValues(args.options.values, args.options.set || [], args.options.setJson || []);
  const result = session.operation === 'backup'
    ? await continueBackup(store, session, values)
    : await continueRestore(store, session, values);
  printSession(result, args.options);
  return result.state === 'failed' ? 1 : 0;
}

async function commandStatus(args) {
  const id = args.positional[1];
  const store = new SessionStore(args.options.stateDir || undefined);
  const session = await store.load(id);
  printSession(session, args.options);
  return 0;
}

async function commandNext(args) {
  const id = args.positional[1];
  const store = new SessionStore(args.options.stateDir || undefined);
  const session = await store.load(id);
  process.stdout.write(`${JSON.stringify({ session: id, state: session.state, next: session.next }, null, 2)}\n`);
  return 0;
}

async function commandInfo(args) {
  const id = args.positional[1];
  const store = new SessionStore(args.options.stateDir || undefined);
  const session = await store.load(id);
  const type = args.options.type;
  const view = args.options.view || 'short';
  if (!['short', 'medium', 'full'].includes(view)) throw new Error(`unsupported info view: ${view}`);
  if (!type && view === 'full') {
    process.stdout.write(`${path.join(store.directory(id), 'session.json')}\n`);
    return 0;
  }
  if (!type) {
    process.stdout.write(`Session: ${id}\nState: ${session.state}\nInformation types:\n`);
    for (const [name, data] of Object.entries(session.info || {})) process.stdout.write(`  ${name}: ${data[view]}\n`);
    return 0;
  }
  const data = session.info?.[type];
  if (!data) throw new Error(`information type is not available: ${type}`);
  if (view === 'full') {
    process.stdout.write(`${data.fullPath}\n`);
    return 0;
  }
  if (!['short', 'medium'].includes(view)) throw new Error(`unsupported info view: ${view}`);
  process.stdout.write(`${data[view]}\n`);
  return 0;
}

async function commandAuth(args) {
  const action = args.positional[1];
  if (action === 'google-workspace') {
    const result = await authorizeGoogleWorkspace({ clientFile: args.options.client, profile: args.options.profile || 'default', noBrowser: Boolean(args.options.noBrowser) });
    process.stdout.write(`Google Workspace profile authorized: ${result.profile}\nToken: ${result.tokenPath}\n`);
    return 0;
  }
  if (action === 'status') {
    process.stdout.write(`${JSON.stringify(await googleAuthStatus(args.options.profile || 'default'), null, 2)}\n`);
    return 0;
  }
  throw new Error('auth requires google-workspace or status');
}

export async function main(argv) {
  if (!argv.length || ['-h', '--help', 'help'].includes(argv[0])) { process.stdout.write(usage()); return 0; }
  const args = parseArgs(argv);
  switch (args.positional[0]) {
    case 'template': return commandTemplate(args);
    case 'backup': return commandBackup(args);
    case 'restore': return commandRestore(args);
    case 'continue': return commandContinue(args);
    case 'status': return commandStatus(args);
    case 'next': return commandNext(args);
    case 'info': return commandInfo(args);
    case 'auth': return commandAuth(args);
    default: throw new Error(`unknown command: ${args.positional[0]}\n\n${usage()}`);
  }
}
