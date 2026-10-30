import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { claudeArgs, claudeVersion, reviewerTools, runClaude, stopGroup } from './claude';
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
const { connect } = require('node:net');
const [mode, port] = process.argv.slice(1);
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');
// A descendant of the CLI. With a port, it holds a connection to the test open until it dies.
const startAdapter = async (stdout) => {
  const stdio = ['ignore', stdout, 'ignore'];
  let link;
  if (port) {
    link = connect(Number(port), '127.0.0.1');
    await new Promise((resolve, reject) => link.once('connect', resolve).once('error', reject));
    stdio.push(link);
  }
  const adapter = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio });
  // The adapter keeps its own copy of the connection; the CLI lets go of its copy.
  link?.destroy();
  return adapter;
};
const browser = ['mcp__audit__click', 'mcp__audit__press', 'mcp__audit__snapshot', 'mcp__audit__wait'];
const tools = mode === 'extra' ? ['Bash', 'StructuredOutput', ...browser] : mode === 'nobrowser' ? ['StructuredOutput'] : ['StructuredOutput', ...browser];
(async () => {
if (mode !== 'noinit') out({ type: 'system', subtype: 'init', model: 'claude-test', tools });
const report = { outcome: 'blocked', observations: 'Saw the heading' };
if (mode === 'orphan') {
  // An adapter that outlives the CLI and keeps the CLI's output open.
  const adapter = await startAdapter('inherit');
  adapter.unref();
}
if (['success', 'noreport', 'noinit', 'orphan'].includes(mode)) {
  out({ type: 'assistant', message: { id: 'a1', content: [{ type: 'tool_use', name: 'mcp__audit__snapshot' }] } });
  out({ type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: 'Done' }] } });
  out({ type: 'assistant', message: { id: 'a2', content: [{ type: 'tool_use', name: 'StructuredOutput' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, ...(mode === 'noreport' ? {} : { structured_output: report }) });
} else if (mode === 'error') out({ type: 'result', subtype: 'error_during_execution', is_error: true });
else if (mode === 'exit') process.exit(3);
else {
  await startAdapter('ignore');
  // 'loop' goes one turn past the cap (3) and then carries on without ending, until the runner stops it.
  // The turns are written at once, not on a timer: a runner starved by a loaded machine would otherwise read
  // an unknown number of them before it stopped the group.
  if (mode === 'loop') for (let turn = 0; turn < 4; turn++) out({ type: 'assistant', message: { id: 'turn' + turn, content: [] } });
  setInterval(() => {}, 1000);
}
})();
`;
const scratch = mkdtempSync(join(tmpdir(), 'brainrot-claude-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fake = (mode: string, options: { seconds?: number; maxTurns?: number; signal?: AbortSignal; descendant?: Descendant } = {}) =>
  runClaude(process.execPath, ['-e', fakeCli, mode, options.descendant?.port ?? ''], { cwd: scratch, env: { PATH: process.env.PATH }, seconds: options.seconds ?? 10, maxTurns: options.maxTurns ?? 5, signal: options.signal ?? new AbortController().signal });

// What a fake CLI's descendant reports to: it holds a connection to this server open until it dies (the CLI
// lets go of its own copy once the descendant has one), so that connection closing is the kernel saying the
// whole group is gone. Waiting on it ends only when the group is cleared.
type Descendant = { port: string; gone: () => Promise<void> };
async function watchDescendant(): Promise<Descendant> {
  const server = createServer();
  const closed = new Promise<void>((resolve) => server.once('connection', (socket) => {
    socket.on('error', () => {});
    socket.once('close', () => resolve());
    socket.resume();
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: String((server.address() as AddressInfo).port), gone: async () => { await closed; server.close(); } };
}

// Records every group kill (a negative pid) while still delivering it, so the real descendants die.
async function groupKills(run: () => Promise<unknown>) {
  const kill = process.kill.bind(process);
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => kill(pid, signal));
  try { await run(); return spy.mock.calls.filter(([pid]) => pid < 0).map(([pid, signal]) => [pid, signal]); } finally { spy.mockRestore(); }
}

describe('Claude reviewer version pin', () => {
  it('is one exact release, and every Claude Code release the docs and notes name is that one', () => {
    expect(claudeVersion).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)$/);
    const pinned = claudeVersion.split(' ')[0];
    // Only versions in a Claude context count; other tools' versions in these files are ignored.
    const release = /Claude\s+Code\s+\**(\d+\.\d+\.\d+)|`claude --help` in (\d+\.\d+\.\d+)|\b[Ii]n (\d+\.\d+\.\d+) --restricted|(\d+\.\d+\.\d+) \(Claude Code\)/g;
    for (const file of ['docs/DEVELOPMENT.md', 'docs/ARCHITECTURE.md', '.claude/skills/qa/SKILL.md', 'scripts/agent-audit/claude.ts', 'scripts/agent-audit/contracts.ts']) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      const named = [...text.matchAll(release)].map((match) => match.slice(1).find(Boolean));
      expect({ file, named: [...new Set(named)] }).toEqual({ file, named: [pinned] });
    }
  });
});

describe('Claude reviewer group kill', () => {
  it('signals a child group at most once and never one without a pid', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const child = { pid: 424242 } as ChildProcess;
      stopGroup(child);
      stopGroup(child);
      expect(spy.mock.calls).toEqual([[-424242, 'SIGKILL']]);
      spy.mockClear();
      stopGroup({ pid: 424243 } as ChildProcess);
      stopGroup({} as ChildProcess);
      expect(spy.mock.calls).toEqual([[-424243, 'SIGKILL']]);
    } finally { spy.mockRestore(); }
  });
});

describe('Claude reviewer runs (mocked CLI)', () => {
  it('returns the structured report, model and model turns from a finished run', async () => {
    expect(await fake('success')).toEqual({ turns: 2, model: 'claude-test', report: JSON.stringify({ outcome: 'blocked', observations: 'Saw the heading' }) });
  });

  it('stops the whole process group at the turn cap and keeps no report', async () => {
    const descendant = await watchDescendant();
    const run = await fake('loop', { maxTurns: 3, descendant });
    expect(run).toEqual({ turns: 4, model: 'claude-test', reason: 'turn budget exhausted' });
    await descendant.gone();
  });

  it('times out and cancels visibly, clearing the group', async () => {
    const descendant = await watchDescendant();
    expect((await fake('hang', { seconds: 0.5, descendant })).reason).toBe('time budget exhausted');
    await descendant.gone();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    expect((await fake('hang', { signal: controller.signal })).reason).toBe('cancelled');
    const aborted = new AbortController();
    aborted.abort();
    expect(await fake('success', { signal: aborted.signal })).toEqual({ turns: 0, reason: 'cancelled' });
  });

  it('clears a descendant that outlives the CLI and holds its output open', async () => {
    const descendant = await watchDescendant();
    expect((await fake('orphan', { seconds: 3, descendant })).report).toBe(JSON.stringify({ outcome: 'blocked', observations: 'Saw the heading' }));
    await descendant.gone();
  });

  it('leaves unavailable tools and unfinished runs without a report', async () => {
    expect((await fake('extra')).reason).toBe('reviewer had tools outside the allowlist');
    expect((await fake('nobrowser')).reason).toBe('audit browser tools unavailable');
    expect((await fake('error')).reason).toBe('agent did not finish (error_during_execution)');
    expect((await fake('noreport')).reason).toBe('agent did not finish (no report)');
    expect((await fake('noinit')).reason).toBe('agent did not report its tools');
    expect((await fake('exit')).reason).toBe('agent CLI incomplete (exit 3)');
    const missing = await runClaude(join(scratch, 'no-such-claude'), [], { cwd: scratch, env: {}, seconds: 5, maxTurns: 5, signal: new AbortController().signal });
    expect(missing).toEqual({ turns: 0, reason: 'Claude CLI unavailable' });
    for (const mode of ['extra', 'nobrowser', 'error', 'noreport', 'noinit', 'exit']) expect((await fake(mode)).report).toBeUndefined();
  });

  it('kills the group once across exit, stop and close, and still reaches a descendant that outlives the CLI', async () => {
    const orphan = await watchDescendant();
    let run: Awaited<ReturnType<typeof fake>> | undefined;
    const exited = await groupKills(async () => { run = await fake('orphan', { seconds: 3, descendant: orphan }); });
    expect(run?.report).toBe(JSON.stringify({ outcome: 'blocked', observations: 'Saw the heading' }));
    expect(exited).toHaveLength(1);
    await orphan.gone();

    const looping = await watchDescendant();
    const stopped = await groupKills(async () => { run = await fake('loop', { maxTurns: 3, descendant: looping }); });
    expect(run?.reason).toBe('turn budget exhausted');
    expect(stopped).toHaveLength(1);
    await looping.gone();
  });
});
