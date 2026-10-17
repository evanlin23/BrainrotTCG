import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeArgs, reviewerTools, runClaude } from './claude';
import { tasks } from './contracts';

// Flags checked against `claude --help` for the pinned release (see docs/DEVELOPMENT.md).
const verifiedFlags = ['-p', '--restricted', '--tools', '--strict-mcp-config', '--mcp-config', '--allowed-tools', '--permission-mode', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--output-format', '--verbose', '--json-schema', '--system-prompt'];

describe('Claude reviewer arguments', () => {
  it('starts a read-only reviewer with only the audit browser tools and the task as its prompt', () => {
    const args = claudeArgs(tasks.opening, '/tmp/audit-mcp.json');
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args.filter((arg) => arg.startsWith('-'))).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config']));
    expect(args.filter((arg) => arg.startsWith('-')).every((flag) => verifiedFlags.includes(flag))).toBe(true);
    expect(value('--tools')).toBe('');
    expect(value('--allowed-tools').split(',')).toEqual(reviewerTools);
    expect(reviewerTools.every((tool) => tool.startsWith('mcp__audit__'))).toBe(true);
    expect(value('--permission-mode')).toBe('dontAsk');
    expect(value('--mcp-config')).toBe('/tmp/audit-mcp.json');
    expect(args.join(' ')).not.toMatch(/\b(Bash|Edit|Write|WebFetch|WebSearch|bypassPermissions)\b|dangerously/);
    // The task follows a single-value flag, so no variadic flag can swallow it.
    expect(args.at(-1)).toBe(tasks.opening);
    expect(args.at(-3)).toBe('--system-prompt');
  });
});

// A stand-in CLI: no provider, no credentials, just the stream-json shapes the runner reads.
const fakeCli = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const [mode, pidFile] = process.argv.slice(1);
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const browser = ['mcp__audit__click', 'mcp__audit__press', 'mcp__audit__snapshot', 'mcp__audit__wait'];
const tools = mode === 'extra' ? ['Bash', 'StructuredOutput', ...browser] : mode === 'nobrowser' ? ['StructuredOutput'] : ['StructuredOutput', ...browser];
out({ type: 'system', subtype: 'init', model: 'claude-test', tools });
const report = { outcome: 'blocked', observations: 'Saw the heading' };
if (mode === 'success' || mode === 'noreport') {
  out({ type: 'assistant', message: { id: 'a1', content: [{ type: 'tool_use', name: 'mcp__audit__snapshot' }] } });
  out({ type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: 'Done' }] } });
  out({ type: 'assistant', message: { id: 'a2', content: [{ type: 'tool_use', name: 'StructuredOutput' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, ...(mode === 'success' ? { structured_output: report } : {}) });
} else if (mode === 'error') out({ type: 'result', subtype: 'error_during_execution', is_error: true });
else if (mode === 'exit') process.exit(3);
else {
  const adapter = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (pidFile) writeFileSync(pidFile, String(adapter.pid));
  let turn = 0;
  if (mode === 'loop') setInterval(() => out({ type: 'assistant', message: { id: 'turn' + turn++, content: [] } }), 20);
  else setInterval(() => {}, 1000);
}
`;
const scratch = mkdtempSync(join(tmpdir(), 'brainrot-claude-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fake = (mode: string, options: { seconds?: number; maxTurns?: number; signal?: AbortSignal; pidFile?: string } = {}) =>
  runClaude(process.execPath, ['-e', fakeCli, mode, options.pidFile ?? ''], { cwd: scratch, env: { PATH: process.env.PATH }, seconds: options.seconds ?? 10, maxTurns: options.maxTurns ?? 5, signal: options.signal ?? new AbortController().signal });
async function gone(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch { return true; }
    try { if (readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z')) return true; } catch { /* Not Linux. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('Claude reviewer runs (mocked CLI)', () => {
  it('returns the structured report, model and model turns from a finished run', async () => {
    expect(await fake('success')).toEqual({ turns: 2, model: 'claude-test', report: JSON.stringify({ outcome: 'blocked', observations: 'Saw the heading' }) });
  });

  it('stops the whole process group at the turn cap and keeps no report', async () => {
    const pidFile = join(scratch, 'turns.pid');
    const run = await fake('loop', { maxTurns: 3, pidFile });
    expect(run).toEqual({ turns: 4, model: 'claude-test', reason: 'turn budget exhausted' });
    expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
  });

  it('times out and cancels visibly, clearing the group', async () => {
    const pidFile = join(scratch, 'time.pid');
    expect((await fake('hang', { seconds: 0.5, pidFile })).reason).toBe('time budget exhausted');
    expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    expect((await fake('hang', { signal: controller.signal })).reason).toBe('cancelled');
    const aborted = new AbortController();
    aborted.abort();
    expect(await fake('success', { signal: aborted.signal })).toEqual({ turns: 0, reason: 'cancelled' });
  });

  it('leaves unavailable tools and unfinished runs without a report', async () => {
    expect((await fake('extra')).reason).toBe('reviewer had tools outside the allowlist');
    expect((await fake('nobrowser')).reason).toBe('audit browser tools unavailable');
    expect((await fake('error')).reason).toBe('agent did not finish (error_during_execution)');
    expect((await fake('noreport')).reason).toBe('agent did not finish (no report)');
    expect((await fake('exit')).reason).toBe('agent CLI incomplete (exit 3)');
    const missing = await runClaude(join(scratch, 'no-such-claude'), [], { cwd: scratch, env: {}, seconds: 5, maxTurns: 5, signal: new AbortController().signal });
    expect(missing).toEqual({ turns: 0, reason: 'Claude CLI unavailable' });
    for (const mode of ['extra', 'nobrowser', 'error', 'noreport', 'exit']) expect((await fake(mode)).report).toBeUndefined();
  }, 20000);
});
