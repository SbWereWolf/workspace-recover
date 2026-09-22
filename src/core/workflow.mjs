import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { buildAggregateReport, buildStepReport, validateReporter } from './reporting.mjs';
import { ensureDir, nowIso, writeJsonAtomic } from './util.mjs';

function expand(value, context) {
  if (Array.isArray(value)) return value.map(item => expand(item, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, context)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_, key) => {
    if (!(key in context)) throw new Error(`workflow placeholder is unresolved: ${key}`);
    return String(context[key]);
  });
}

async function runCommand(step, workspace, stepDir, context) {
  const argv = expand(step.argv, context);
  if (!Array.isArray(argv) || !argv.length || argv.some(item => typeof item !== 'string')) throw new Error(`workflow step ${step.id} requires argv string array`);
  const cwd = path.resolve(workspace, expand(step.cwd || '.', context));
  const env = { ...process.env, ...expand(step.env || {}, context) };
  const stdoutPath = path.join(stepDir, 'stdout.log');
  const stderrPath = path.join(stepDir, 'stderr.log');
  const stdout = await fsp.open(stdoutPath, 'w', 0o600);
  const stderr = await fsp.open(stderrPath, 'w', 0o600);
  const startedAt = nowIso();
  const start = Date.now();
  let code = null;
  let signal = null;
  let spawnError = null;
  let timedOut = false;
  try {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, stdio: ['ignore', stdout.fd, stderr.fd] });
    const terminal = await new Promise(resolve => {
      let timer = null, killTimer = null;
      if (step.timeoutMs) timer = setTimeout(() => { timedOut=true; child.kill('SIGTERM'); killTimer=setTimeout(()=>child.kill('SIGKILL'),250); }, step.timeoutMs);
      child.on('error', error => resolve({ error }));
      child.on('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
      child.on('close', () => { if (timer) clearTimeout(timer); if(killTimer)clearTimeout(killTimer); });
    });
    if (terminal.error) spawnError = terminal.error.message;
    else { code = terminal.exitCode; signal = terminal.exitSignal; }
  } finally {
    await stdout.close();
    await stderr.close();
  }
  const stdoutText = await fsp.readFile(stdoutPath, 'utf8');
  const stderrText = await fsp.readFile(stderrPath, 'utf8');
  const status = spawnError ? 'error' : !timedOut && code === 0 ? 'passed' : 'failed';
  return { id: step.id, type: step.type, argv, cwd, status, exitCode: code, signal, spawnError, timedOut, startedAt, finishedAt: nowIso(), durationMs: Date.now() - start, stdout: stdoutText, stderr: stderrText, stdoutPath, stderrPath };
}

/** Structural validation is separate from author-owned step policy. */
export function validateWorkflow(steps) {
  if (!Array.isArray(steps)) throw new Error('workflow must be an array');
  const ids = new Set();
  for (const [index, step] of steps.entries()) {
    if (typeof step?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(step.id) || ids.has(step.id)) {
      throw new Error(`workflow step id is unsafe or duplicated at index ${index}`);
    }
    ids.add(step.id);
    if (!['command', 'verification'].includes(step.type)) throw new Error(`unsupported workflow step at index ${index}`);
    if (!['success', 'always'].includes(step.when ?? 'success')) throw new Error(`workflow step ${step.id} has unsupported when`);
    if (!Array.isArray(step.argv) || !step.argv.length || !step.argv[0] || step.argv.some(x => typeof x !== 'string' || x.includes('\0'))) {
      throw new Error(`workflow step ${step.id} requires argv string array`);
    }
    if (step.cwd !== undefined && typeof step.cwd !== 'string') throw new Error(`workflow step ${step.id} requires a string cwd`);
    if (step.timeoutMs !== undefined && (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs <= 0)) throw new Error(`workflow step ${step.id} requires a positive timeoutMs`);
    if (step.report !== undefined) validateReporter(step.report);
    if (step.env !== undefined && (step.env === null || typeof step.env !== 'object' || Array.isArray(step.env) || Object.values(step.env).some(x => typeof x !== 'string'))) throw new Error(`workflow step ${step.id} requires string env values`);
  }
}

export async function executeWorkflow({ steps = [], workspace, sessionDir, context = {} }) {
  validateWorkflow(steps);
  const results = [];
  let hardFailure = false;
  let advisoryWarnings = false;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step?.id || !['command', 'verification'].includes(step.type)) throw new Error(`unsupported workflow step at index ${index}`);
    const when = step.when || 'success';
    if (hardFailure && when !== 'always') {
      results.push({ id: step.id, type: step.type, status: 'skipped', exitCode: null, reason: 'prior hard failure' });
      continue;
    }
    const stepDir = path.join(sessionDir, 'steps', `${String(index).padStart(3, '0')}-${step.id}`);
    await ensureDir(stepDir);
    const result = await runCommand(step, workspace, stepDir, { workspace, stepDir, ...context });
    try {
      result.report = await buildStepReport({ result, report: expand(step.report || { profile: 'command-output' },{workspace,stepDir,...context}), reportDir: path.join(stepDir, 'report'), workspace });
    } catch (error) {
      // A reporter failure is evidence failure, not authorization to skip cleanup.
      result.reportError = error.message;
      const fullPath = path.join(stepDir, 'report-error.json');
      await writeJsonAtomic(fullPath, { result, reportingError: error.message });
      result.report = { short: `report unavailable; command=${result.status}`, medium: `Reporter error: ${error.message}\nCommand exit: ${result.exitCode}\nRaw stdout: ${result.stdoutPath}\nRaw stderr: ${result.stderrPath}`, fullPath };
      advisoryWarnings = true;
    }
    results.push(result);
    if (result.status !== 'passed') {
      if (step.type === 'verification') advisoryWarnings = true;
      else hardFailure = true;
    }
  }
  const verificationItems = results.filter(item => item.type === 'verification');
  const verificationReport = await buildAggregateReport({ type: 'verification', items: verificationItems, reportDir: path.join(sessionDir, 'reports', 'verification') });
  const workflowReport = await buildAggregateReport({ type: 'workflow', items: results, reportDir: path.join(sessionDir, 'reports', 'workflow') });
  return { results, hardFailure, advisoryWarnings, verificationReport, workflowReport };
}
