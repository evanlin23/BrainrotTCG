import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { preview as startPreview } from 'vite';
import { bridgeHandler, browserCommand, isolate, stepBudget } from './browser';
import { claudeArgs, claudeVersion, runClaude, stopGroup } from './claude';
import { agentEnvironment, clean, coordinatorPrompt, instructionFiles, isBasePath, parseOptions, parseOutcome, redactReportTasks, tasks, uncommittedBuildInputs } from './contracts';

const root = process.cwd();
const output = resolve('test-results/agent-audit.json');
const children = new Set<ChildProcess>();
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const stop = stopGroup;
async function command(command: string, args: string[], cwd: string, seconds: number, env: NodeJS.ProcessEnv) {
  if (controller.signal.aborted) throw Error('cancelled');
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', env });
  children.add(child);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(child); }, seconds * 1000);
  const abort = () => stop(child);
  controller.signal.addEventListener('abort', abort, { once: true });
  if (controller.signal.aborted) stop(child);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      // Clear anything the command left behind in its group, whatever its exit code.
      child.once('exit', (code) => { stop(child); if (code === 0) resolve(); else reject(Error(controller.signal.aborted ? 'cancelled' : timedOut ? 'time budget exhausted' : `command incomplete (exit ${code ?? 'signal'})`)); });
    });
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abort);
    children.delete(child);
  }
}
const report: Record<string, unknown> = {
  outcome: 'unrun', label: 'Simulated agent reviewers (Claude Code), not human newcomers; Chromium browser emulation, not a real device.',
  tasks: [], limitations: [
    'No native share, screen reader, real phone or real save evidence.',
    'Browser actions are limited to disposable local state; sharing/export/clipboard actions are deliberately blocked.',
    `One sequential agent per task, at most four tasks, the turn and time limits below and ${stepBudget} browser calls each; provider usage is not metered by this runner.`,
    'No screenshots, raw model/provider streams, private storage or authentication material are retained.',
  ], coordinatorPrompt,
};
let temporary: string | undefined;
let preview: Awaited<ReturnType<typeof startPreview>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  if (process.platform === 'win32') throw Error('This runner currently supports Unix process cleanup only');
  const { selected, seconds, turns } = parseOptions(process.argv.slice(2));
  report.tasks = selected.map((task) => ({ task, prompt: tasks[task], outcome: 'unrun', reason: 'Not started' }));
  report.limits = { agents: selected.length, sequential: true, taskSeconds: seconds, turns, browserCalls: stepBudget, buildSeconds: 300 };
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (revision.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(revision.stdout)) throw Error('Revision unavailable');
  report.revision = revision.stdout.trim();
  const drift = uncommittedBuildInputs(root);
  if (drift) throw Error(drift);
  const agentEnv = agentEnvironment(process.env);
  temporary = await mkdtemp(join(tmpdir(), 'brainrot-audit-'));
  const version = spawnSync('claude', ['--version'], { cwd: temporary, encoding: 'utf8', timeout: 10000, env: agentEnv });
  if (version.status !== 0 || version.stdout.trim() !== claudeVersion) throw Error(`Claude Code ${claudeVersion} unavailable; no agent ran`);
  report.runner = claudeVersion;
  const auth = spawnSync('claude', ['auth', 'status', '--json'], { cwd: temporary, encoding: 'utf8', timeout: 20000, env: agentEnv });
  let signedIn = false;
  try { signedIn = auth.status === 0 && JSON.parse(auth.stdout).loggedIn === true; } catch { /* Not signed in. */ }
  if (!signedIn) throw Error('Claude Code is not signed in; no agent ran');
  // Memory or rules files would coach the reviewer; reviewers run in folders under `temporary`.
  const coaching = instructionFiles(agentEnv.HOME, temporary);
  if (coaching.length) {
    console.error(`Move these Claude instruction files away before auditing:\n${coaching.join('\n')}`);
    throw Error('Claude instruction files (CLAUDE.md, CLAUDE.local.md, AGENTS.md or rules) would coach reviewers; no agent ran');
  }
  await command('npm', ['run', 'build'], root, 300, process.env);
  const port = 4197;
  const basePath = process.env.BASE_PATH ?? '/BrainrotTCG/';
  if (!isBasePath(basePath)) throw Error('Unsupported base path');
  const baseURL = `http://127.0.0.1:${port}${basePath}`;
  // Programmatic preview resolves only after its own server binds; a pre-existing listener
  // fails strictPort rather than being mistaken for this revision.
  preview = await startPreview({ configFile: false, base: basePath, preview: { host: '127.0.0.1', port, strictPort: true } });
  const response = await fetch(baseURL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok || await response.text() !== await readFile(join(root, 'dist/index.html'), 'utf8')) throw Error('Owned built preview not ready');
  report.build = 'Fresh npm run build; owned strict-port preview index matched dist/index.html';
  browser = await chromium.launch();
  report.conditions = { basePath, engine: `Chromium ${browser.version()}`, viewport: { width: 393, height: 727 }, touch: true, reducedMotion: true, cache: 'fresh context with routing', network: 'local only; no throttling', cpu: 'no throttling', fixture: 'disposable deterministic identity; no pre-existing pulls' };
  for (const [index, task] of selected.entries()) {
    if (controller.signal.aborted) throw Error('cancelled');
    const context = await browser.newContext({ viewport: { width: 393, height: 727 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false });
    const steps: string[] = [];
    const errors: string[] = [];
    const blocked = await isolate(context, baseURL);
    const page = await context.newPage();
    const noteError = (kind: string) => { if (errors.length < 40) errors.push(kind); };
    page.on('pageerror', () => noteError('Browser page error; reproduce locally for details'));
    page.on('console', (message) => { if (message.type() === 'error') noteError('Browser console error; reproduce locally for details'); });
    page.on('requestfailed', () => noteError('Browser request failed; reproduce locally for details'));
    const token = randomBytes(24).toString('hex');
    const bridge = createServer(bridgeHandler(token, (command) => browserCommand(page, command, steps)));
    const taskReport: Record<string, unknown> = { task, prompt: tasks[task], outcome: 'unrun', steps, errors, blockedNetwork: blocked };
    (report.tasks as unknown[])[index] = taskReport;
    try {
      await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
      const address = bridge.address();
      if (!address || typeof address === 'string') throw Error('Bridge unavailable');
      await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const taskDirectory = join(temporary, task);
      await mkdir(taskDirectory);
      // The token stays in a private file, not in the agent's argv.
      const mcpConfig = join(temporary, `${task}-mcp.json`);
      await writeFile(mcpConfig, JSON.stringify({ mcpServers: { audit: { command: process.execPath, args: [join(root, 'scripts/agent-audit/browser-mcp.mjs')], env: { BRAINROT_AUDIT_ENDPOINT: `http://127.0.0.1:${address.port}/${token}` } } } }), { mode: 0o600 });
      const run = await runClaude('claude', claudeArgs(tasks[task], mcpConfig), { cwd: taskDirectory, env: agentEnv, seconds, maxTurns: turns, signal: controller.signal });
      Object.assign(taskReport, { model: run.model, turns: run.turns });
      if (run.reason || !run.report) throw Error(run.reason ?? 'agent did not finish');
      Object.assign(taskReport, parseOutcome(run.report, steps));
    } catch (error) { taskReport.reason = clean(error instanceof Error ? error.message : 'Task incomplete'); }
    finally { await context.close(); bridge.closeAllConnections(); await new Promise<void>((resolve) => bridge.close(() => resolve())); }
  }
  const outcomes = (report.tasks as { outcome: string }[]).map((task) => task.outcome);
  report.outcome = outcomes.every((outcome) => outcome === 'completed') ? 'completed' : outcomes.every((outcome) => outcome === 'unrun') ? 'unrun' : 'incomplete';
} catch (error) {
  report.reason = clean(error instanceof Error ? error.message : 'Audit incomplete');
} finally {
  controller.abort();
  for (const child of children) stop(child);
  if (preview) await new Promise<void>((resolve) => { if ('closeAllConnections' in preview!.httpServer) preview!.httpServer.closeAllConnections(); preview!.httpServer.close(() => resolve()); });
  await browser?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  await mkdir(resolve('test-results'), { recursive: true });
  if (Array.isArray(report.tasks)) redactReportTasks(report.tasks);
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Local audit ${report.outcome}; sanitized report: test-results/agent-audit.json`);
  process.exitCode = report.outcome === 'completed' ? 0 : 1;
}
