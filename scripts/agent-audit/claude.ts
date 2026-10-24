import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

// Every flag in claudeArgs was listed by `claude --help` in this release. Any other version
// fails closed until someone re-checks the flags and updates this pin.
export const claudeVersion = '2.1.302 (Claude Code)';
export const reviewerTools = ['snapshot', 'click', 'press', 'wait'].map((name) => `mcp__audit__${name}`);
// Added by --json-schema; it only returns the final report.
const reportTool = 'StructuredOutput';
export const reviewerSystemPrompt = 'You are trying a web game in a browser. Use only the audit browser tools. Describe what you actually did, detours, confusing labels and errors. If you cannot finish, report blocked or ambiguous. Do not infer success. Do not inspect source, files, saves or credentials. Do not submit, copy, download, export or send anything.';
const reportSchema = { type: 'object', properties: { outcome: { type: 'string', enum: ['completed', 'blocked', 'ambiguous'] }, observations: { type: 'string' } }, required: ['outcome', 'observations'], additionalProperties: false };

// Read-only reviewer: --tools '' removes every built-in tool (Bash, Edit, Write, WebFetch...),
// --restricted ignores user, project and local settings files and their hooks (in 2.1.302 it also
// skipped every CLAUDE.md, AGENTS.md and rules file; run.ts refuses while any exist anyway),
// --strict-mcp-config loads only the audit browser server, and dontAsk denies anything outside the
// allowlist. The task is the only user prompt.
export function claudeArgs(task: string, mcpConfig: string) {
  return [
    '-p', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--allowed-tools', reviewerTools.join(','), '--permission-mode', 'dontAsk',
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(reportSchema),
    '--system-prompt', reviewerSystemPrompt, task,
  ];
}

// Kills the child's whole process group, even after the leader exits: an MCP adapter or other
// descendant may outlive it. It signals at most once per child. SIGKILL to the group ends every
// member, and Linux does not reuse a PID number while any process still has it as its PGID, so the
// first kill (at the latest on the leader's 'exit', before anything else could take the number)
// reaches only our group. After that the group may be empty and its number free for an unrelated
// process, so every later call (stop, 'exit', 'close') is a no-op.
const signalled = new WeakSet<ChildProcess>();
export function stopGroup(child: ChildProcess) {
  if (!child.pid || signalled.has(child)) return;
  signalled.add(child);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Group already gone. */ }
}

export type ClaudeRun = { turns: number; model?: string; report?: string; reason?: string };

// Runs one reviewer and always resolves. A reason means the task is unrun: no report is trusted.
// Turns are model responses (distinct assistant message ids); this release has no turn flag, so
// the runner stops the whole process group, MCP adapter included, when response N+1 starts.
export async function runClaude(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; seconds: number; maxTurns: number; signal: AbortSignal }): Promise<ClaudeRun> {
  const run: ClaudeRun = { turns: 0 };
  if (options.signal.aborted) return { ...run, reason: 'cancelled' };
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  // The CLI may exit before its MCP adapter or another descendant that holds stdout open, which
  // would keep 'close' from firing; clear the group as soon as the CLI itself exits.
  child.once('exit', () => stopGroup(child));
  let stopped: string | undefined;
  const stop = (reason: string) => { stopped ??= reason; stopGroup(child); };
  const timer = setTimeout(() => stop('time budget exhausted'), options.seconds * 1000);
  const abort = () => stop('cancelled');
  options.signal.addEventListener('abort', abort, { once: true });
  const ids = new Set<string>();
  let tools: string[] | undefined;
  let result: Record<string, unknown> | undefined;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'system' && message.subtype === 'init') {
      tools = Array.isArray(message.tools) ? message.tools.map(String) : [];
      if (typeof message.model === 'string') run.model = message.model.slice(0, 80);
      if (tools.some((tool) => tool !== reportTool && !reviewerTools.includes(tool))) stop('reviewer had tools outside the allowlist');
      else if (!reviewerTools.every((tool) => tools!.includes(tool))) stop('audit browser tools unavailable');
    } else if (message.type === 'assistant') {
      const id = (message.message as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string') ids.add(id);
      run.turns = ids.size;
      if (ids.size > options.maxTurns) stop('turn budget exhausted');
    } else if (message.type === 'result') result = message;
  });
  const exit = await new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });
  clearTimeout(timer);
  options.signal.removeEventListener('abort', abort);
  stopGroup(child);
  if (stopped) return { ...run, reason: stopped };
  if (exit.error) return { ...run, reason: exit.error.code === 'ENOENT' ? 'Claude CLI unavailable' : 'Claude CLI could not start' };
  if (exit.code !== 0) return { ...run, reason: `agent CLI incomplete (exit ${exit.code ?? 'signal'})` };
  if (!tools) return { ...run, reason: 'agent did not report its tools' };
  if (!result || result.subtype !== 'success' || result.is_error !== false) {
    return { ...run, reason: `agent did not finish (${typeof result?.subtype === 'string' ? result.subtype.slice(0, 40) : 'no result'})` };
  }
  if (!result.structured_output || typeof result.structured_output !== 'object') return { ...run, reason: 'agent did not finish (no report)' };
  return { ...run, report: JSON.stringify(result.structured_output) };
}
