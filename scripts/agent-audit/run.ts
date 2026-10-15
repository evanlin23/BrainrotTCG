import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { preview as startPreview } from 'vite';
import { browserCommand, isolate } from './browser';
import { clean, coordinatorPrompt, isBasePath, parseOptions, parseOutcome, tasks } from './contracts';

const root = process.cwd();
const output = resolve('test-results/agent-audit.json');
const children = new Set<ChildProcess>();
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const stop = (child: ChildProcess) => {
  if (child.exitCode === null && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
  }
};
async function command(command: string, args: string[], cwd: string, seconds: number) {
  if (controller.signal.aborted) throw Error('cancelled');
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', env: process.env });
  children.add(child);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(child); }, seconds * 1000);
  const abort = () => stop(child);
  controller.signal.addEventListener('abort', abort, { once: true });
  if (controller.signal.aborted) stop(child);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(Error(controller.signal.aborted ? 'cancelled' : timedOut ? 'time budget exhausted' : `command incomplete (exit ${code ?? 'signal'})`)));
    });
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abort);
    children.delete(child);
  }
}
const report: Record<string, unknown> = {
  outcome: 'unrun', tasks: [], limitations: [
    'Local Codex CLI audit, not human participants or actual phones; no native share, screen reader or real save evidence.',
    'Browser actions are limited to disposable local state; sharing/export/clipboard actions are deliberately blocked.',
    'One sequential agent per task, at most four tasks and 40 browser calls each; optional provider usage is not metered by this runner.',
    'No screenshots, raw model/provider streams, private storage or authentication material are retained.',
  ], coordinatorPrompt,
};
let temporary: string | undefined;
let preview: Awaited<ReturnType<typeof startPreview>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  if (process.platform === 'win32') throw Error('This runner currently supports Unix process cleanup only');
  const { selected, seconds } = parseOptions(process.argv.slice(2));
  report.limits = { agents: selected.length, sequential: true, taskSeconds: seconds, buildSeconds: 300 };
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (revision.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(revision.stdout)) throw Error('Revision unavailable');
  report.revision = revision.stdout.trim();
  if (spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim()) throw Error('Commit tracked changes before auditing a known revision');
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.status !== 0 || version.stdout.trim() !== 'codex-cli 0.159.2') throw Error('Supported Codex CLI 0.159.2 unavailable; no agent ran');
  report.runner = version.stdout.trim();
  temporary = await mkdtemp(join(tmpdir(), 'brainrot-audit-'));
  await command('npm', ['run', 'build'], root, 300);
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
  const schema = join(temporary, 'report-schema.json');
  await writeFile(schema, JSON.stringify({ type: 'object', properties: { outcome: { type: 'string', enum: ['completed', 'blocked', 'ambiguous'] }, observations: { type: 'string' } }, required: ['outcome', 'observations'], additionalProperties: false }));
  for (const task of selected) {
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
    const bridge = createServer(async (request, response) => {
      if (request.url !== `/${token}` || request.method !== 'POST') { response.writeHead(404).end(); return; }
      let body = '';
      try {
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 4096) throw Error('Oversized command');
        }
        response.end(await browserCommand(page, JSON.parse(body), steps));
      } catch { response.writeHead(400).end('Browser action blocked or unavailable'); }
    });
    const taskReport: Record<string, unknown> = { task, prompt: tasks[task], outcome: 'unrun', steps, errors, blockedNetwork: blocked };
    (report.tasks as unknown[]).push(taskReport);
    try {
      await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
      const address = bridge.address();
      if (!address || typeof address === 'string') throw Error('Bridge unavailable');
      await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const taskDirectory = join(temporary, task);
      await mkdir(taskDirectory);
      const last = join(temporary, `${task}.json`);
      const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'view_image', 'hooks', 'skill_search', 'workspace_dependencies', 'remote_plugin', 'browser_use_full_cdp_access', 'code_mode_host', 'sleep_tool'];
      const args = ['--no-daemon', '--ask-for-approval', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', taskDirectory, '--output-schema', schema, '-o', last];
      for (const feature of disabled) args.push('--disable', feature);
      args.push('-c', 'web_search="disabled"', '-c', 'mcp_servers.audit.command="' + process.execPath + '"', '-c', `mcp_servers.audit.args=${JSON.stringify([join(root, 'scripts/agent-audit/browser-mcp.mjs')])}`, '-c', `mcp_servers.audit.env.BRAINROT_AUDIT_ENDPOINT="http://127.0.0.1:${address.port}/${token}"`);
      args.push(`${tasks[task]}\nUse only the audit browser tools. Describe what you actually did, detours, confusing labels and errors. If you cannot finish, report blocked or ambiguous. Do not infer success. Do not inspect source, files, saves or credentials. Do not submit, copy, download, export or send anything.`);
      await command('codex', args, taskDirectory, seconds);
      Object.assign(taskReport, parseOutcome(await readFile(last, 'utf8'), steps));
    } catch (error) { taskReport.reason = clean(error instanceof Error ? error.message : 'Task incomplete'); }
    finally { await context.close(); bridge.closeAllConnections(); await new Promise<void>((resolve) => bridge.close(() => resolve())); }
  }
  report.outcome = (report.tasks as { outcome: string }[]).every((task) => task.outcome === 'completed') ? 'completed' : 'incomplete';
} catch (error) {
  report.reason = clean(error instanceof Error ? error.message : 'Audit incomplete');
} finally {
  controller.abort();
  for (const child of children) stop(child);
  if (preview) await new Promise<void>((resolve) => { if ('closeAllConnections' in preview!.httpServer) preview!.httpServer.closeAllConnections(); preview!.httpServer.close(() => resolve()); });
  await browser?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  await mkdir(resolve('test-results'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Local audit ${report.outcome}; sanitized report: test-results/agent-audit.json`);
  process.exitCode = report.outcome === 'completed' ? 0 : 1;
}
