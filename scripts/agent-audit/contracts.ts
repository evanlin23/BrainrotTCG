import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const tasks = {
  opening: 'You found this game for the first time. Try to open a pack and find out what you received.',
  sharing: 'Try to understand how rare an item is and how you would show one item to a friend. Do not send, submit, copy, download or export anything.',
  results: 'Try to find your own previous results and compare them with results from other people.',
  recovery: 'Explore whether you can comfortably use this game with a keyboard and recover when something is confusing. Do not change browser settings or import/export anything.',
} as const;
export type Task = keyof typeof tasks;
// Email redaction. The pinned runner gives the player the signed-in account's context, so a
// narration may write the address out ("name at example dot com", "name [at] example [dot] com",
// "name @ example.com") or break it across lines or fields. Plain-word "at" and "dot" are ordinary
// prose, so a match with no bracket or "@" marker counts only when it uses a spelled " dot ", ends in
// a well-known TLD and has a non-stopword host ("meet at the dot com" survives). Known limits: a
// host written with literal dots after a written "at" ("jane at example.com"), "jane at example com",
// space-separated names ("first last at ..." keeps "first"), and mid-word or spaced-letter breaks.
const bracketOpen = '[\\[({<]';
const bracketClose = '[\\])}>]';
const spelledDot = `(?:\\s*${bracketOpen}\\s*dot\\s*${bracketClose}\\s*|\\s+dot\\s+)`;
const spelledAt = `(?:\\s*${bracketOpen}\\s*at\\s*${bracketClose}\\s*|\\s*@\\s*|\\s+at\\s+)`;
const writtenEmail = new RegExp(
  `(?<![\\w.+-])[\\w.+-]+(?:${spelledDot}[\\w.+-]+)*${spelledAt}[a-z0-9-]+(?:(?:${spelledDot}|\\.)[a-z0-9-]+)+(?![\\w-])`, 'gi');
const knownTlds = new Set(['com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'uk', 'us', 'ca', 'de', 'fr', 'au', 'in', 'jp', 'cn', 'ru', 'br', 'nl', 'se', 'no', 'ch', 'info', 'biz', 'dev', 'app', 'ai', 'me', 'tv', 'xyz', 'online', 'tech', 'site']);
const proseHosts = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'their', 'its', 'his', 'her', 'one', 'each', 'every', 'some', 'any', 'it', 'there', 'here', 'what', 'which', 'home', 'work', 'school']);
function redactEmails(text: string): string {
  return text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]').replace(writtenEmail, (match) => {
    // A newline here is a field boundary from redactAcrossFields; keep it so fields stay aligned.
    const boundaries = '\n'.repeat(match.split('\n').length - 1);
    // A bracketed or "@" form is certain, but its top-level domain must be letters ("3 @ 12.5 seconds" is not an address).
    if (/[[({<@]/.test(match)) return /(?<![a-z0-9-])[a-z]{2,}$/i.test(match) ? '[email]' + boundaries : match;
    const host = /\s+at\s+([a-z0-9-]+)/i.exec(match)?.[1]?.toLowerCase() ?? '';
    const tld = match.split(/\s+dot\s+|\./i).at(-1)?.toLowerCase() ?? '';
    return /\sdot\s/i.test(match) && knownTlds.has(tld) && !proseHosts.has(host) ? '[email]' + boundaries : match;
  });
}
// Control characters (line breaks included) become spaces before matching, so an address broken
// across lines is one address. Invisible format characters (zero-width, soft hyphen, bidi, invisible operators), U+034F and variation selectors are dropped.
function stripped(value: unknown): string {
  return String(value).replace(/[\p{Cf}\u034f\ufe00-\ufe0f]/gu, '').split('').map((character) => character.charCodeAt(0) < 32 || character === '\u0085' ? ' ' : character).join('');
}
export function clean(value: unknown): string {
  const kept = stripped(value).replace(/https?:\/\/[^\s]+/g, '[URL]').replace(/[a-f0-9]{32,}/gi, '[opaque value]');
  // NFKC folds full-width "@" and "." for matching only; text with no address keeps its own characters,
  // so a click label still matches the control's accessible name.
  const folded = kept.normalize('NFKC');
  const redacted = redactEmails(folded);
  return (redacted === folded ? kept : redacted).slice(0, 1200);
}
/** Redacts addresses written out across adjacent already-cleaned fields (one field per element). */
export function redactAcrossFields(fields: string[]): string[] {
  if (fields.some((field) => field.includes('\n'))) throw Error('Fields must be cleaned first');
  // Match on the NFKC-folded text; a field keeps its own characters unless something in it was redacted.
  const folded = fields.map((field) => field.normalize('NFKC'));
  const redacted = redactEmails(folded.join('\n')).split('\n');
  return redacted.map((field, index) => field === folded[index] ? fields[index]! : field.trim());
}
const stepPrefix = /^((?:not completed: )?click: )(.*)$/s;
/** Final pass over a report's participant text: click labels, observations and reasons, so an address split between them is still removed. */
export function redactReportTasks(tasks: unknown[]): void {
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const record = task as { steps?: unknown; observations?: unknown; reason?: unknown };
    const steps = Array.isArray(record.steps) ? record.steps as string[] : [];
    const clicks = steps.flatMap((step, index) => typeof step === 'string' && stepPrefix.test(step) ? [index] : []);
    const fields = [...clicks.map((index) => steps[index]!.replace(stepPrefix, (_, _prefix: string, label: string) => label)), typeof record.observations === 'string' ? record.observations : '', typeof record.reason === 'string' ? record.reason : ''];
    const redacted = redactAcrossFields(fields);
    clicks.forEach((index, position) => { steps[index] = steps[index]!.replace(stepPrefix, (_, prefix: string) => prefix + redacted[position]); });
    if (typeof record.observations === 'string') record.observations = redacted[clicks.length];
    if (typeof record.reason === 'string') record.reason = redacted[clicks.length + 1];
  }
}
export function parseOptions(args: string[]) {
  const selected: Task[] = [];
  let seconds = 90;
  let turns = 15;
  for (const argument of args) {
    if (argument.startsWith('--task=')) {
      const task = argument.slice(7);
      if (!Object.hasOwn(tasks, task) || selected.includes(task as Task)) throw Error('Unknown or duplicate task');
      selected.push(task as Task);
    } else if (/^--seconds=\d+$/.test(argument)) seconds = Number(argument.slice(10));
    else if (/^--turns=\d+$/.test(argument)) turns = Number(argument.slice(8));
    else throw Error('Use --task=opening|sharing|results|recovery, --seconds=30..180 and --turns=3..40');
  }
  if (seconds < 30 || seconds > 180) throw Error('Task limit must be 30..180 seconds');
  if (turns < 3 || turns > 40) throw Error('Turn limit must be 3..40');
  return { selected: selected.length ? selected : ['opening'] as Task[], seconds, turns };
}
export function parseOutcome(raw: string, steps: string[]) {
  if (raw.length > 16384) throw Error('Oversized agent report');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw Error('Invalid agent report');
  const { outcome, observations } = value as Record<string, unknown>;
  if (!['completed', 'blocked', 'ambiguous'].includes(String(outcome)) || typeof observations !== 'string') throw Error('Invalid agent report');
  if (outcome === 'completed' && (!steps.some((step) => step.startsWith('snapshot:')) || !steps.some((step) => /^(click|press):/.test(step)))) throw Error('No browser evidence');
  return { outcome, observations: clean(observations) };
}
export const coordinatorPrompt = 'Review actual task reports without coaching the reviewers. Reproduce observations on the same revision and conditions, distinguish blocked tasks from product defects, deduplicate against canonical issues, and retest affected tasks with a fresh reviewer after fixes. Prepare evidence for owner review; do not publish, merge or deploy. Agent outcomes are not human statistics.';

export function isBasePath(value: string) {
  return /^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(value);
}

// The agent CLI gets only what it needs to start and reach its own provider: no CI, GitHub, npm
// or cloud tokens, and nothing from the coordinator's own configuration. The browser endpoint
// reaches the MCP adapter through its config, not this environment.
const agentVariables = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
];
export function agentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(agentVariables.flatMap((name) => env[name] === undefined ? [] : [[name, env[name]]]));
}

// Instruction files a CLI session loads as memory: managed and user memory and rules, and
// CLAUDE.md, CLAUDE.local.md, AGENTS.md and .claude/ memory or rules in the working directory and
// every directory above it. Marker files showed Claude Code 2.1.314 --restricted keeping a
// working-directory CLAUDE.md, CLAUDE.local.md and .claude/rules out (nothing else was tested), but
// its help promises only to skip settings files, so the runner refuses while any of these exist.
export function instructionFiles(home: string | undefined, cwd: string): string[] {
  const paths = ['/etc/claude-code/CLAUDE.md', '/Library/Application Support/ClaudeCode/CLAUDE.md'];
  if (home) paths.push(join(home, '.claude', 'CLAUDE.md'), join(home, '.claude', 'rules'));
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    paths.push(...['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/rules'].map((name) => join(directory, name)));
    if (dirname(directory) === directory) break;
  }
  return paths.filter((path) => existsSync(path));
}

// The registry imports sets explicitly, but Vite globs set art (src/content/sets/*/...) and copies
// public/, so untracked files there, such as a draft set, would ship in a build labelled with this
// revision. Ignored files and untracked files elsewhere never reach the build.
export function uncommittedBuildInputs(cwd: string): string {
  const status = (...args: string[]) => {
    const result = spawnSync('git', ['status', '--porcelain', ...args], { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw Error('Git status unavailable');
    return result.stdout.trim();
  };
  if (status('--untracked-files=no')) return 'Commit tracked changes before auditing a known revision';
  if (status('--untracked-files=all', '--', 'src', 'public')) return 'Commit or remove untracked files under src/ or public/ (such as a draft set) before auditing a known revision';
  return '';
}
