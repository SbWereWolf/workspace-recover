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

function junitSummary(xml) {
  const attrs = {};
  const root = xml.match(/<testsuites?\b([^>]*)>/i)?.[1] || '';
  for (const key of ['tests', 'failures', 'errors', 'skipped', 'time']) {
    const match = root.match(new RegExp(`${key}="([^"]+)"`, 'i'));
    if (match) attrs[key] = match[1];
  }
  const failures = [...xml.matchAll(/<(failure|error)\b[^>]*message="([^"]*)"[^>]*>/gi)].slice(0, 10).map(match => match[2]);
  return { attrs, failures };
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
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (code !== 0) throw new Error(`custom reporter failed with exit ${code}: ${stderr.trim()}`);
  const parsed = JSON.parse(stdout);
  if (typeof parsed.short !== 'string' || typeof parsed.medium !== 'string') throw new Error('custom reporter must emit JSON with string short and medium');
  return parsed;
}

export async function buildStepReport({ result, report = { profile: 'command-output' }, reportDir, workspace }) {
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
