import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ensureDir, readJson, sha256File, writeJsonAtomic, writeTextAtomic } from './util.mjs';

async function preserveSource(source, reportDir) {
  // Capture declared primary evidence before the next manifest step can remove it.
  const destination = path.join(reportDir, 'source' + path.extname(source));
  await fsp.copyFile(source, destination);
  await fsp.chmod(destination, 0o600);
  return destination;
}

function lines(text) {
  return String(text || '').split(/\r?\n/).map(x => x.trimEnd()).filter(Boolean);
}

function commandOutputMedium(result) {
  const out = lines(result.stdout);
  const err = lines(result.stderr);
  const interesting = [];
  if (err.length) interesting.push(`stderr (${err.length} lines):`, ...err.slice(-12));
  if (out.length) interesting.push(`stdout (${out.length} lines):`, ...out.slice(-12));
  return [
    `status: ${result.status}`,
    `exitCode: ${result.exitCode}`,
    `durationMs: ${result.durationMs}`,
    `stdoutBytes: ${Buffer.byteLength(result.stdout || '')}`,
    `stderrBytes: ${Buffer.byteLength(result.stderr || '')}`,
    ...interesting,
  ].join('\n');
}

export const REPORTER_PROFILES = Object.freeze(['command-output','json','json-lines','junit','tap','artifact-list','custom-command']);
export function validateReporter(report) {
  if(!report || typeof report!=='object' || Array.isArray(report) || !REPORTER_PROFILES.includes(report.profile || 'command-output'))throw new Error(`unsupported report profile: ${report?.profile}`);
  if(['json','json-lines','junit'].includes(report.profile) && typeof report.source!=='string')throw new Error('report source is required');
  if(report.profile==='artifact-list' && (!Array.isArray(report.sources) || report.sources.some(x=>typeof x!=='string')))throw new Error('artifact-list sources must be paths');
  if(report.profile==='custom-command' && (!Array.isArray(report.argv) || !report.argv.length || report.argv.some(x=>typeof x!=='string' || x.includes('\0'))))throw new Error('custom reporter requires argv');
  if(report.timeoutMs!==undefined && (!Number.isSafeInteger(report.timeoutMs) || report.timeoutMs<=0))throw new Error('report timeout must be positive');
}

function junitSummary(xml) {
  if(!/<testsuites?\b/.test(xml))throw new Error('JUnit report has no testsuite root');
  const attrsOf = text => Object.fromEntries([...text.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1],m[2]]));
  const numeric = a => Object.fromEntries(['tests','failures','errors','skipped','time'].map(k=>[k,Number(a[k] || 0)]));
  const root=attrsOf(xml.match(/<testsuites?\b([^>]*)>/i)?.[1] || '');
  let attrs;
  if(root.tests!==undefined)attrs=root;
  else {
    const stack=[], totals={tests:0,failures:0,errors:0,skipped:0,time:0};
    // Add outer suites once; do not double count parent aggregate + child suites.
    for(const match of xml.matchAll(/<(\/?)testsuite\b([^>]*)>/g)) {
      if(match[1]){stack.pop();continue;}
      const a=attrsOf(match[2]);
      const counted=stack.some(x=>x);
      const own=a.tests!==undefined;
      if(!counted && own)for(const [k,v] of Object.entries(numeric(a)))totals[k]+=v;
      if(!match[2].trimEnd().endsWith('/'))stack.push(own || counted);
    }
    attrs=totals;
  }
  const failures=[...xml.matchAll(/<(failure|error)\b[^>]*message=["']([^"']*)["'][^>]*>/gi)].slice(0,10).map(m=>m[2]);
  return {attrs,failures};
}

function tapSummary(text) {
  const all=String(text).split(/\r?\n/);
  const cases=all.filter(l=>/^(not )?ok\b/.test(l));
  const counter=k=>{const matches=[...String(text).matchAll(new RegExp(`^# ${k} (\\d+)\\s*$`,'gm'))];return matches.length?Number(matches.at(-1)[1]):null;};
  const tests=counter('tests') ?? cases.length;
  const failures=counter('fail') ?? cases.filter(l=>l.startsWith('not ok')&&!/# (TODO|SKIP)/i.test(l)).length;
  const skipped=counter('skipped') ?? cases.filter(l=>/# SKIP/i.test(l)).length;
  return {tests,failures,skipped,failedCases:cases.filter(l=>l.startsWith('not ok')).slice(0,10)};
}

async function customReporter({ report, context, cwd }) {
  const env = { ...process.env, ...Object.fromEntries(Object.entries(context).map(([key, value]) => [`WR_${key.toUpperCase()}`, String(value)])) };
  const argv = report.argv || [];
  if (!argv.length) throw new Error('custom reporter requires report.argv');
  const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout=setTimeout(()=>child.kill('SIGKILL'),report.timeoutMs || 120000);
  let code;try{code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});}finally{clearTimeout(timeout);}
  if (code !== 0) throw new Error(`custom reporter failed with exit ${code}: ${stderr.trim()}`);
  const parsed = JSON.parse(stdout);
  if (typeof parsed.short !== 'string' || typeof parsed.medium !== 'string') throw new Error('custom reporter must emit JSON with string short and medium');
  return parsed;
}

export async function buildStepReport({ result, report = { profile: 'command-output' }, reportDir, workspace }) {
  validateReporter(report);
  await ensureDir(reportDir);
  const primary = path.join(reportDir, 'primary.json');
  await writeJsonAtomic(primary, result);
  let short;
  let medium;
  let fullPath = primary;
  switch (report.profile || 'command-output') {
    case 'command-output':
      short = `${result.status}; exit=${result.exitCode}; ${result.durationMs}ms`;
      medium = commandOutputMedium(result);
      break;
    case 'json': {
      const source = await preserveSource(path.resolve(workspace, report.source), reportDir);
      const data = await readJson(source);
      short = report.shortKey ? String(data[report.shortKey]) : `JSON result: ${Object.keys(data).length} top-level keys`;
      medium = JSON.stringify(data, null, 2).slice(0, report.mediumMaxChars || 12000);
      fullPath = source;
      break;
    }
    case 'junit': {
      const source = await preserveSource(path.resolve(workspace, report.source), reportDir);
      const xml = await fsp.readFile(source, 'utf8');
      const summary = junitSummary(xml);
      short = `tests=${summary.attrs.tests ?? '?'} failures=${summary.attrs.failures ?? '?'} errors=${summary.attrs.errors ?? '?'} skipped=${summary.attrs.skipped ?? '?'}`;
      medium = `${short}\ntime=${summary.attrs.time ?? '?'}\n${summary.failures.length ? `failures:\n- ${summary.failures.join('\n- ')}` : 'no reported failure messages'}`;
      fullPath = source;
      break;
    }
    case 'tap': {
      const summary=tapSummary(result.stdout);
      short=`tests=${summary.tests} failures=${summary.failures} skipped=${summary.skipped}`;
      medium=`${short}\ncommandExit=${result.exitCode} durationMs=${result.durationMs}\n${summary.failedCases.join('\n') || 'No failed cases reported'}`;
      break;
    }
    case 'json-lines': {
      const source=await preserveSource(path.resolve(workspace,report.source),reportDir);
      const rows=(await fsp.readFile(source,'utf8')).split(/\r?\n/).filter(l=>l.trim()).map(l=>JSON.parse(l));
      const counts={};for(const row of rows){const key=String(row.level ?? row.status ?? 'record');counts[key]=(counts[key] || 0)+1;}
      short=`${rows.length} records; ${(await fsp.stat(source)).size} bytes`;
      medium=`${short}\nCounts by level/status: ${JSON.stringify(counts)}\n${rows.filter(x=>x.error || x.level==='error' || x.status==='failed').slice(0,10).map(x=>JSON.stringify(x)).join('\n')}`;
      fullPath=source;break;
    }
    case 'artifact-list': {
      const artifacts=[];
      for(const [i,relative] of report.sources.entries()){
        const source=path.resolve(workspace,relative);const saved=path.join(reportDir,`artifact-${i}${path.extname(source)}`);
        await fsp.copyFile(source,saved);await fsp.chmod(saved,0o600);
        artifacts.push({name:relative,path:saved,bytes:(await fsp.stat(saved)).size,sha256:await sha256File(saved)});
      }
      fullPath=path.join(reportDir,'artifacts.json');await writeJsonAtomic(fullPath,{schema:'workspace-recover/artifact-report/v2',artifacts});
      short=`${artifacts.length} artifacts; ${artifacts.reduce((n,x)=>n+x.bytes,0)} bytes`;
      medium=`${short}\n${artifacts.map(x=>`${x.name}: ${x.bytes} bytes; SHA256 ${x.sha256}`).join('\n')}`;
      break;
    }
    case 'custom-command': {
      const parsed = await customReporter({
        report,
        cwd: workspace,
        context: { primaryPath: primary, stdoutPath: result.stdoutPath, stderrPath: result.stderrPath, workspace },
      });
      short = parsed.short;
      medium = parsed.medium;
      if (parsed.fullPath) {
        const candidate = path.resolve(workspace, parsed.fullPath);
        await fsp.access(candidate);
        fullPath = await preserveSource(candidate, reportDir);
      }
      break;
    }
    default:
      throw new Error(`unsupported report profile: ${report.profile}`);
  }
  await writeTextAtomic(path.join(reportDir, 'short.txt'), `${short}\n`);
  await writeTextAtomic(path.join(reportDir, 'medium.txt'), `${medium}\n`);
  const sourceArtifact = { path: fullPath, bytes: (await fsp.stat(fullPath)).size, sha256: await sha256File(fullPath) };
  await writeJsonAtomic(path.join(reportDir, 'source-artifact.json'), sourceArtifact);
  return { short, medium, fullPath, sourceArtifact };
}

export async function buildAggregateReport({ type, items, reportDir }) {
  await ensureDir(reportDir);
  const primary = path.join(reportDir, 'primary.json');
  await writeJsonAtomic(primary, { type, items });
  const warnings = items.filter(item => item.status !== 'passed' || item.reportError);
  const short = `${items.length} result(s); ${warnings.length} warning/error result(s)`;
  const medium = items.map(item => `${item.id}: ${item.status}${item.exitCode === null || item.exitCode === undefined ? '' : ` exit=${item.exitCode}`}`).join('\n') || 'no results';
  await writeTextAtomic(path.join(reportDir, 'short.txt'), `${short}\n`);
  await writeTextAtomic(path.join(reportDir, 'medium.txt'), `${medium}\n`);
  return { short, medium, fullPath: primary };
}
