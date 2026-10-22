import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isMainModule } from './main-module.ts';
import { BLOCKER_DISPOSITIONS, RECORD_PATH } from './release-blockers.ts';

/**
 * Bounded recurring quality review for the trusted /work lifecycle (#713).
 *
 * This is a deterministic decision helper, not a runner or a scheduler. At /work setup or a
 * checkpoint the coordinator runs `check`; if a review is due it spends at most the budget on one
 * small slice, then runs `record` and keeps the single state line it prints in the ledger.
 * Rules, all enforced here:
 * - It only reads evidence that already exists (reports, history of origin/main). It never runs the suite, an
 *   audit or an agent, and it makes no network calls.
 * - Every signal is pass, fail, blocked or unrun. A failed, blocked or unrun slice never refreshes
 *   the "passed" date or revision, and keeps its journey and hotspot so the same slice is retried.
 * - Time, git data, files and tools are injected, so tests are deterministic.
 * - State holds dates, revisions, statuses, scope and issue numbers only: no saves, keys, logs or
 *   report bodies.
 * Usage and policy: docs/DEVELOPMENT.md (Quality review cadence).
 */

export type Status = 'pass' | 'fail' | 'blocked' | 'unrun';
export const STATUSES: readonly Status[] = ['pass', 'fail', 'blocked', 'unrun'];
/** .claude/hooks/orient.mjs truncates a ledger line at 240 characters; the state line stays well under. */
export const MAX_STATE_CHARS = 215;
/** Longest hotspot path kept in the line (the longest non-test source path today is 51). */
export const MAX_HOTSPOT_CHARS = 60;
/** Newest issue numbers kept in the state line. */
export const MAX_STATE_ISSUES = 4;

export interface Budget { tasks: number; minutes: number; providerRuns: number }
export const DEFAULT_CADENCE_DAYS = 7;
export const DEFAULT_BUDGET: Budget = { tasks: 3, minutes: 45, providerRuns: 2 };
/** After a blocked or unrun review the next check is tomorrow: it costs nothing until tools return. */
export const RETRY_DAYS = 1;
/** An evidence report older than this is shown as stale, never as current. */
export const DEFAULT_MAX_EVIDENCE_AGE_DAYS = 14;
/** Used when the previous revision is unknown: look at this much history for hotspots. */
export const HISTORY_DAYS = 30;

export interface ReviewState {
  cadenceDays: number;
  budget: Budget;
  lastStatus?: Status;
  lastDate?: string;
  lastRev?: string;
  passedDate?: string;
  passedRev?: string;
  nextDue?: string;
  journey?: string;
  hotspot?: string;
  issues: number[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REV = /^[0-9a-f]{7,40}$/;
const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
export const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

const STATE_PREFIX = 'quality review:';

/** One ledger line, e.g. `quality review: last=pass@2026-10-20:abc1234 ...`. Default cadence and budget are omitted. */
export const formatState = (state: ReviewState): string => {
  const parts: string[] = [];
  const { tasks, minutes, providerRuns } = state.budget;
  if (state.cadenceDays !== DEFAULT_CADENCE_DAYS) parts.push(`every=${state.cadenceDays}d`);
  if (tasks !== DEFAULT_BUDGET.tasks || minutes !== DEFAULT_BUDGET.minutes || providerRuns !== DEFAULT_BUDGET.providerRuns) parts.push(`budget=${tasks}t/${minutes}m/${providerRuns}p`);
  if (state.lastStatus && state.lastDate && state.lastRev) parts.push(`last=${state.lastStatus}@${state.lastDate}:${state.lastRev}`);
  // A pass is also the passed review: only write `passed` when it differs from `last`.
  const passedIsLast = state.lastStatus === 'pass' && state.passedDate === state.lastDate && state.passedRev === state.lastRev;
  if (state.passedDate && state.passedRev && !passedIsLast) parts.push(`passed=${state.passedDate}:${state.passedRev}`);
  if (state.nextDue) parts.push(`next=${state.nextDue}`);
  if (state.journey) parts.push(`journey=${state.journey}`);
  if (state.hotspot) parts.push(`hotspot=${state.hotspot}`);
  if (state.issues.length > 0) parts.push(`issues=${state.issues.map((n) => `#${n}`).join(',')}`);
  return [STATE_PREFIX, ...parts].join(' ');
};

/** Parses the ledger line. Throws on anything malformed, so a bad line is never read as "passed". */
export const parseState = (line: string): ReviewState => {
  const text = line.trim();
  if (!text.toLowerCase().startsWith(STATE_PREFIX)) throw new Error(`State line must start with "${STATE_PREFIX}"`);
  const state: ReviewState = { cadenceDays: DEFAULT_CADENCE_DAYS, budget: { ...DEFAULT_BUDGET }, issues: [] };
  const bad = (field: string): never => { throw new Error(`Bad ${field} in quality review state`); };
  const dated = (value: string, field: string): [string, string] => {
    const [first, second] = value.split(/[@:]/);
    return DAY.test(first ?? '') && REV.test(second ?? '') ? [first, second] : bad(field);
  };
  for (const token of text.slice(STATE_PREFIX.length).trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf('=');
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (eq < 0) bad(token);
    if (key === 'every') {
      const days = /^(\d{1,3})d$/.exec(value);
      if (!days || Number(days[1]) < 1) bad('every');
      state.cadenceDays = Number(days![1]);
    } else if (key === 'budget') {
      const parts = /^(\d{1,3})t\/(\d{1,4})m\/(\d{1,3})p$/.exec(value);
      if (!parts) bad('budget');
      state.budget = { tasks: Number(parts![1]), minutes: Number(parts![2]), providerRuns: Number(parts![3]) };
    } else if (key === 'last') {
      const [status, rest] = value.split('@');
      if (!STATUSES.includes(status as Status) || !rest) bad('last');
      state.lastStatus = status as Status;
      [state.lastDate, state.lastRev] = dated(rest!, 'last');
    } else if (key === 'passed') {
      [state.passedDate, state.passedRev] = dated(value, 'passed');
    } else if (key === 'next') {
      if (!DAY.test(value)) bad('next');
      state.nextDue = value;
    } else if (key === 'journey' || key === 'hotspot') {
      if (!/^[\w./-]{1,120}$/.test(value)) bad(key);
      state[key] = value;
    } else if (key === 'issues') {
      if (!/^#\d+(,#\d+){0,19}$/.test(value)) bad('issues');
      state.issues = value.split(',').map((item) => Number(item.slice(1)));
    } else bad(key);
  }
  if (state.lastStatus === 'pass' && !state.passedDate) { state.passedDate = state.lastDate; state.passedRev = state.lastRev; }
  return state;
};

// --- Due check -------------------------------------------------------------------------------

export interface DueDecision { due: boolean; reason: string; nextDue: string | null }

/**
 * Due when no review is recorded, or the next-due day has come and main has changed since the last
 * passed review (idle weeks cost nothing). A review that did not pass is retried whenever it is due.
 */
export const decideDue = (state: ReviewState | null, today: string, commitsSinceLast: number | null): DueDecision => {
  if (!state || !state.lastDate) return { due: true, reason: 'no review recorded', nextDue: null };
  const nextDue = state.nextDue ?? addDays(state.lastDate, state.lastStatus === 'pass' || state.lastStatus === 'fail' ? state.cadenceDays : RETRY_DAYS);
  if (today < nextDue) return { due: false, reason: `next due ${nextDue}`, nextDue };
  if (state.lastStatus === 'pass' && commitsSinceLast === 0) {
    return { due: false, reason: `idle: no commits since ${state.lastRev}`, nextDue };
  }
  return { due: true, reason: `due since ${nextDue}`, nextDue };
};

// --- Slice -----------------------------------------------------------------------------------

export interface Journey {
  id: string;
  label: string;
  /** Source paths (prefixes) whose change makes this journey the first to inspect. */
  paths: readonly string[];
  /** Existing Claude-only task audit that covers it (docs/DEVELOPMENT.md), or null for a fixture-based browser check. */
  agentTask: 'opening' | 'sharing' | 'results' | 'recovery' | null;
}

/** Rotation order; each entry is one screen or state to judge with REVIEW_CRITERIA, not a matrix. */
export const JOURNEYS: readonly Journey[] = [
  { id: 'opening', label: 'Home, open a pack, results', agentTask: 'opening', paths: ['src/components/pack/', 'src/game/pack', 'src/game/pulls', 'src/game/reveal', 'src/App'] },
  { id: 'collection-detail', label: 'Collection and card detail', agentTask: null, paths: ['src/components/collection/', 'src/components/cards/', 'src/game/cardStats', 'src/game/bestCards'] },
  { id: 'sharing', label: 'Sharing and receiving', agentTask: 'sharing', paths: ['src/components/share/', 'src/game/move', 'src/game/cardCode', 'src/game/qrCode', 'src/game/bragImage', 'src/game/finishImage'] },
  { id: 'profile', label: 'Own and shared Profile', agentTask: null, paths: ['src/components/profile/', 'src/game/profiles', 'src/game/player'] },
  { id: 'rankings', label: 'Rankings (Hall of Fame)', agentTask: null, paths: ['src/components/pages/HallOfFame', 'src/game/hallOfFame', 'src/game/nostrInbox', 'scripts/hall-of-fame'] },
  { id: 'settings-help', label: 'Settings and help', agentTask: null, paths: ['src/components/pages/SettingsPage', 'src/game/diagnostics'] },
  { id: 'recovery', label: 'Interrupted pack and save recovery', agentTask: 'recovery', paths: ['src/game/collectionRecovery', 'src/game/progress', 'src/game/history', 'src/game/reopenCache', 'src/game/reload'] },
];

/** The hierarchy review criterion (#712), applied to the one journey the slice picks. */
export const REVIEW_CRITERIA: readonly string[] = [
  'player job -> primary fact -> next action (#712)',
  'same-scope duplication is a finding; repeated context, accessible text and exported artifacts are not',
  'screenshots alone do not judge hierarchy: pair any #745 baseline with a semantic review',
];

export interface Change { file: string; commits: number; lines: number }
export interface SliceItem { kind: 'journey' | 'hotspot'; id: string | null; detail: string }

const isCode = (file: string): boolean =>
  /^(src|scripts)\//.test(file) && /\.(ts|tsx|mjs)$/.test(file) && !/\.(test|spec)\./.test(file);

/** Journeys whose source changed since the last review: per-PR checks still run for these at once. */
export const touchedJourneys = (changedFiles: readonly string[]): string[] =>
  JOURNEYS.filter((journey) => changedFiles.some((file) => journey.paths.some((prefix) => file.startsWith(prefix)))).map((journey) => journey.id);

export const pickJourney = (state: ReviewState | null, changedFiles: readonly string[]): Journey => {
  const start = Math.max(-1, JOURNEYS.findIndex((journey) => journey.id === state?.journey)) + 1;
  const order = [...JOURNEYS.slice(start), ...JOURNEYS.slice(0, start)];
  const touched = new Set(touchedJourneys(changedFiles));
  return order.find((journey) => touched.has(journey.id)) ?? order[0];
};

/** Highest churn x size file that was not the previous pick, so the hotspot rotates. */
export const pickHotspot = (changes: readonly Change[], previous?: string): Change | null => {
  const ranked = changes
    .filter((change) => isCode(change.file) && change.commits > 0)
    .sort((a, b) => b.commits * b.lines - a.commits * a.lines || a.file.localeCompare(b.file));
  return ranked.find((change) => change.file !== previous) ?? ranked[0] ?? null;
};

export interface Tools { claude: boolean; chromium: boolean }

/** `applicable: false` is nothing to review (not a blocker): the coordinator leaves it out of the record's status. */
export interface PlannedItem extends SliceItem { planned: boolean; applicable: boolean; reason: string; cost: Budget }

/**
 * Fits the slice into the budget in order (journey first). An item that cannot run is blocked with
 * the reason, not skipped silently, so the record can never read as a pass.
 */
export const planSlice = (journey: Journey, hotspot: Change | null, budget: Budget, tools: Tools): PlannedItem[] => {
  const left = { ...budget };
  const items: PlannedItem[] = [];
  const add = (item: SliceItem, cost: Budget, missing: string | null, applicable = true): void => {
    const over = left.tasks < cost.tasks ? 'task budget exhausted'
      : left.minutes < cost.minutes ? 'time budget exhausted'
      : left.providerRuns < cost.providerRuns ? 'provider-use budget exhausted' : null;
    const reason = missing ?? over;
    if (!reason) { left.tasks -= cost.tasks; left.minutes -= cost.minutes; left.providerRuns -= cost.providerRuns; }
    items.push({ ...item, planned: !reason, applicable, reason: reason ?? 'planned', cost });
  };
  const viaAgent = journey.agentTask !== null;
  const missingTools = viaAgent && (!tools.claude || !tools.chromium)
    ? `missing tools: ${[!tools.claude && 'claude', !tools.chromium && 'chromium'].filter(Boolean).join(', ')}` : null;
  add(
    { kind: 'journey', id: journey.id, detail: viaAgent ? `audit:agent task ${journey.agentTask}, fresh task-only reviewer` : 'fixture-based browser check (tests/browser helpers)' },
    { tasks: 1, minutes: viaAgent ? 10 : 5, providerRuns: viaAgent ? 1 : 0 }, missingTools);
  add(
    { kind: 'hotspot', id: hotspot?.file ?? null, detail: hotspot ? `${hotspot.commits} commits, ${hotspot.lines} lines: read-only review` : 'no changed code file in range' },
    { tasks: 1, minutes: 10, providerRuns: 0 }, hotspot ? null : 'not applicable: no code changed since the last review', hotspot !== null);
  return items;
};

// --- Evidence --------------------------------------------------------------------------------

export interface Source { id: string; label: string; issue: string; path: string; native?: 'agent-audit' | 'release-blockers' | 'report-only' }

export const EVIDENCE_DIR = 'test-results/quality-evidence';
/**
 * Where each existing signal is read from. A source with a native report reads that file; every
 * source also accepts a compact `{status,date,detail}` JSON at `test-results/quality-evidence/<id>.json`,
 * which the coordinator writes for signals that live on GitHub (CI, review, advisories, branches).
 * A missing file is `unrun`: that is the honest answer for a tool that has not shipped or not run.
 */
export const SOURCES: readonly Source[] = [
  { id: 'ci-review', label: 'CI and review failures', issue: 'CLAUDE.md merge bar', path: `${EVIDENCE_DIR}/ci-review.json` },
  { id: 'test-runtime', label: 'Test runtime', issue: '#702', path: `${EVIDENCE_DIR}/test-runtime.json` },
  { id: 'performance', label: 'Performance (report-only)', issue: '#702', path: 'test-results/performance/summary.json', native: 'report-only' },
  { id: 'capacity', label: 'Capacity', issue: '#708/#709/#242', path: 'test-results/capacity/summary.json' },
  { id: 'compatibility', label: 'Compatibility', issue: '#658', path: `${EVIDENCE_DIR}/compatibility.json` },
  { id: 'release-blockers', label: 'Release blockers record', issue: '#759', path: RECORD_PATH, native: 'release-blockers' },
  { id: 'dependency-advisories', label: 'Dependency advisory disposition', issue: 'docs/DEVELOPMENT.md', path: `${EVIDENCE_DIR}/dependency-advisories.json` },
  { id: 'branch-hygiene', label: 'Branch hygiene', issue: '#710', path: `${EVIDENCE_DIR}/branch-hygiene.json` },
  { id: 'agent-audit', label: 'Agent task audit (simulated reviewers)', issue: '#239', path: 'test-results/agent-audit.json', native: 'agent-audit' },
  // Never inferred from emulation or agent runs: unrun until a person records a result.
  { id: 'physical-device', label: 'Physical device', issue: '#32', path: `${EVIDENCE_DIR}/physical-device.json` },
  { id: 'screen-reader', label: 'Screen reader', issue: '#32', path: `${EVIDENCE_DIR}/screen-reader.json` },
  { id: 'native-share', label: 'Native sharing', issue: '#32', path: `${EVIDENCE_DIR}/native-share.json` },
];

export interface FileRead { text: string; mtime: string }
/** Last commit day of a repo file on origin/main (from `git`), keyed by path; a file with no entry has no known date. */
export type CommitDates = Readonly<Record<string, string | undefined>>;
export type ReadFile = (path: string) => FileRead | null;

export interface Signal {
  id: string; label: string; issue: string; status: Status;
  date: string | null; ageDays: number | null; fresh: boolean; detail: string;
}

const asStatus = (value: unknown): Status | null => (STATUSES.includes(value as Status) ? (value as Status) : null);
const clip = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').slice(0, 100);

type Reading = { status: Status; date: string | null; detail: string };

const stampOf = (json: Record<string, unknown>): string | null =>
  [json.date, json.generatedAt, json.finishedAt, json.createdAt].map((value) => String(value ?? '').slice(0, 10)).find((value) => DAY.test(value)) ?? null;

/** Open means anything not `resolved`: unresolved, an exception (expired or not) or a corrective release, and an unknown or missing disposition fails closed. */
const interpretBlockers = (json: Record<string, unknown>, today: string, date: string | null): Reading => {
  if (!Array.isArray(json.blockers)) return { status: 'fail', date, detail: 'blocker list missing or malformed' };
  const blockers: unknown[] = json.blockers;
  let open = 0; let invalid = 0; let expired = 0;
  for (const item of blockers) {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as { disposition?: unknown; mitigation?: { expiresAt?: unknown } };
    const known = BLOCKER_DISPOSITIONS.includes(entry.disposition as (typeof BLOCKER_DISPOSITIONS)[number]);
    if (entry.disposition === 'resolved') continue;
    open++;
    if (!known) invalid++;
    else if (entry.disposition === 'mitigated_exception' && !(String(entry.mitigation?.expiresAt ?? '').slice(0, 10) > today)) expired++;
  }
  const notes = [invalid > 0 && `${invalid} invalid`, expired > 0 && `${expired} expired exception`].filter(Boolean).join(', ');
  return { status: open === 0 ? 'pass' : 'fail', date, detail: `${open} of ${blockers.length} blockers open${notes ? ` (${notes})` : ''}; record only, no checks run` };
};

const interpret = (source: Source, read: FileRead, today: string, committed: CommitDates): Reading => {
  let json: Record<string, unknown>;
  try { json = JSON.parse(read.text) as Record<string, unknown>; } catch { return { status: 'unrun', date: null, detail: 'unreadable report' }; }
  if (typeof json !== 'object' || json === null) return { status: 'unrun', date: null, detail: 'unreadable report' };
  // The blockers record carries no date: its last commit day on origin/main is the only honest one. A file mtime is a checkout time.
  if (source.native === 'release-blockers') return interpretBlockers(json, today, committed[source.path] ?? null);
  const date = stampOf(json) ?? read.mtime;
  if (source.native === 'agent-audit') {
    const outcome = json.outcome;
    const status: Status = outcome === 'completed' ? 'pass' : outcome === 'unrun' ? 'unrun' : 'blocked';
    return { status, date, detail: `outcome ${clip(outcome)}; simulated reviewers, not human evidence` };
  }
  if (source.native === 'report-only') {
    // scripts/performance-reporter.ts: status is the Playwright run status; createdAt is when the run began.
    const scenarios = Array.isArray(json.scenarios) ? json.scenarios as { recordedRuns?: unknown }[] : [];
    const recorded = scenarios.reduce((sum, item) => sum + (typeof item?.recordedRuns === 'number' ? item.recordedRuns : 0), 0);
    const stamp = stampOf(json);
    if (scenarios.length === 0 || recorded === 0) return { status: 'unrun', date: stamp, detail: 'no samples recorded' };
    return { status: json.status === 'passed' ? 'pass' : 'fail', date: stamp, detail: `run ${clip(json.status)}; timings are report-only, no budget` };
  }
  const status = asStatus(json.status);
  return status ? { status, date, detail: clip(json.detail) } : { status: 'unrun', date, detail: 'no recognised status in report' };
};

export const collectSignals = (read: ReadFile, today: string, committed: CommitDates = {}, maxAgeDays = DEFAULT_MAX_EVIDENCE_AGE_DAYS): Signal[] =>
  SOURCES.map((source) => {
    const found = read(source.path);
    const base = { id: source.id, label: source.label, issue: source.issue };
    if (!found) return { ...base, status: 'unrun', date: null, ageDays: null, fresh: false, detail: `no report at ${source.path}` };
    const { status, date, detail } = interpret(source, found, today, committed);
    const ageDays = date ? daysBetween(date, today) : null;
    return { ...base, status, date, ageDays, fresh: ageDays !== null && ageDays >= 0 && ageDays <= maxAgeDays, detail };
  });

// --- Review and record -----------------------------------------------------------------------

export interface GitInfo { head: string; commitsSinceLast: number | null; changes: Change[]; changedFiles: string[]; committed: CommitDates }

export interface Review {
  today: string; decision: DueDecision; head: string; touched: string[];
  journey: Journey | null; slice: PlannedItem[]; criteria: readonly string[]; signals: Signal[];
}

export const review = (input: { state: ReviewState | null; now: Date; git: GitInfo; tools: Tools; read: ReadFile }): Review => {
  const today = dayOf(input.now);
  const decision = decideDue(input.state, today, input.git.commitsSinceLast);
  const signals = collectSignals(input.read, today, input.git.committed);
  const touched = touchedJourneys(input.git.changedFiles);
  if (!decision.due) return { today, decision, head: input.git.head, touched, journey: null, slice: [], criteria: [], signals };
  const budget = input.state?.budget ?? DEFAULT_BUDGET;
  const journey = pickJourney(input.state, input.git.changedFiles);
  const slice = planSlice(journey, pickHotspot(input.git.changes, input.state?.hotspot), budget, input.tools);
  return { today, decision, head: input.git.head, touched, journey, slice, criteria: REVIEW_CRITERIA, signals };
};

/** Slice result: pass only if every planned item passed; unrun parts of the slice make it not a pass. */
export const overallStatus = (results: readonly Status[]): Status => {
  if (results.length === 0) return 'unrun';
  for (const status of ['fail', 'blocked', 'unrun'] as const) if (results.includes(status)) return status;
  return 'pass';
};

/** The next ledger state. Only a pass moves `passed`; only a finished review rotates the slice. */
export const recordRun = (
  previous: ReviewState | null,
  run: { now: Date; rev: string; status: Status; journey: string | null; hotspot: string | null; issues?: readonly number[] },
): ReviewState => {
  const base = previous ?? { cadenceDays: DEFAULT_CADENCE_DAYS, budget: { ...DEFAULT_BUDGET }, issues: [] };
  const today = dayOf(run.now);
  const finished = run.status === 'pass' || run.status === 'fail';
  const next: ReviewState = {
    ...base,
    lastStatus: run.status, lastDate: today, lastRev: run.rev,
    nextDue: addDays(today, finished ? base.cadenceDays : RETRY_DAYS),
    issues: [...new Set([...base.issues, ...(run.issues ?? [])])].slice(-MAX_STATE_ISSUES),
  };
  if (run.status === 'pass') { next.passedDate = today; next.passedRev = run.rev; }
  if (finished) {
    if (run.journey) next.journey = run.journey;
    if (run.hotspot) next.hotspot = run.hotspot;
  }
  return next;
};

export const formatReview = (result: Review): string => {
  const lines = [`quality review ${result.decision.due ? 'DUE' : 'not due'} (${result.decision.reason}) today=${result.today} head=${result.head}`];
  if (result.touched.length > 0) lines.push(`flow changes since last review (per-PR checks still apply now): ${result.touched.join(', ')}`);
  if (!result.decision.due) return lines.join('\n');
  if (result.journey) {
    lines.push(`slice: journey ${result.journey.id} (${result.journey.label})`);
    for (const item of result.slice) lines.push(`  ${item.kind} ${item.id ?? '-'}: ${item.planned ? 'planned' : item.applicable ? `BLOCKED, ${item.reason}` : `n/a, ${item.reason}`}; ${item.detail}`);
    lines.push(...result.criteria.map((criterion) => `  criterion: ${criterion}`));
  }
  lines.push('signals (existing evidence only, nothing rerun):');
  for (const signal of result.signals) {
    const when = signal.date ? `${signal.date}${signal.fresh ? '' : ' STALE'}` : 'no date';
    lines.push(`  ${signal.status.padEnd(7)} ${signal.id} [${signal.issue}] ${when}: ${signal.detail}`);
  }
  return lines.join('\n');
};

// --- Command line ----------------------------------------------------------------------------

const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The only ref history is read from, so an unmerged branch never reaches a record or the churn ranking. */
export const MAIN_REF = 'origin/main';

const readGit = (state: ReviewState | null, now: Date): GitInfo => {
  const head = git(['rev-parse', '--short', MAIN_REF]);
  let range = [`--since=${addDays(dayOf(now), -HISTORY_DAYS)}`];
  let commitsSinceLast: number | null = null;
  if (state?.lastRev) {
    try { git(['cat-file', '-e', `${state.lastRev}^{commit}`]); range = [`${state.lastRev}..${MAIN_REF}`]; commitsSinceLast = Number(git(['rev-list', '--count', ...range])); } catch { /* Unknown revision: use dated history. */ }
  }
  const counts = new Map<string, number>();
  for (const file of git(['log', '--no-merges', '--name-only', '--format=', ...range, MAIN_REF]).split('\n').filter(Boolean)) counts.set(file, (counts.get(file) ?? 0) + 1);
  const changes: Change[] = [];
  for (const [file, commits] of counts) {
    if (!isCode(file)) continue;
    try { changes.push({ file, commits, lines: git(['show', `${MAIN_REF}:${file}`]).split('\n').length }); } catch { /* Deleted on main. */ }
  }
  const committed: Record<string, string> = {};
  for (const source of SOURCES.filter((item) => item.native === 'release-blockers')) {
    const day = git(['log', '-1', '--format=%cs', MAIN_REF, '--', source.path]);
    if (DAY.test(day)) committed[source.path] = day;
  }
  return { head, commitsSinceLast, changes, changedFiles: [...counts.keys()], committed };
};

const readDisk: ReadFile = (path) => {
  try { return { text: readFileSync(path, 'utf8'), mtime: statSync(path).mtime.toISOString().slice(0, 10) }; } catch { return null; }
};

/** The blockers record is read as it is on origin/main, not as the working tree happens to have it. */
const readMainOrDisk: ReadFile = (path) => {
  if (path !== RECORD_PATH) return readDisk(path);
  try { return { text: git(['show', `${MAIN_REF}:${path}`]), mtime: '' }; } catch { return null; }
};

const detectTools = async (): Promise<Tools> => {
  let chromium = false;
  try { chromium = existsSync((await import('@playwright/test')).chromium.executablePath()); } catch { /* Not installed. */ }
  return { claude: spawnSync('claude', ['--version'], { stdio: 'ignore', timeout: 10_000 }).status === 0, chromium };
};

const option = (args: string[], name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

export const main = async (args: string[]): Promise<number> => {
  const [command, ...rest] = args;
  const stateLine = option(rest, 'state') ?? (option(rest, 'state-file') ? (readDisk(option(rest, 'state-file')!)?.text.split('\n').find((line) => line.toLowerCase().startsWith(STATE_PREFIX)) ?? '') : '');
  const now = option(rest, 'now') ? new Date(option(rest, 'now')!) : new Date();
  if (Number.isNaN(now.getTime())) { console.error('Bad --now'); return 2; }
  const state = stateLine ? parseState(stateLine) : null;
  if (command === 'check') {
    console.log(formatReview(review({ state, now, git: readGit(state, now), tools: await detectTools(), read: readMainOrDisk })));
    return 0;
  }
  if (command === 'record') {
    const status = asStatus(option(rest, 'status'));
    if (!status) { console.error('record needs --status=pass|fail|blocked|unrun'); return 2; }
    const journey = option(rest, 'journey');
    const hotspot = option(rest, 'hotspot');
    if (journey !== undefined && !JOURNEYS.some((item) => item.id === journey)) { console.error(`Bad --journey (one of ${JOURNEYS.map((item) => item.id).join(', ')})`); return 2; }
    if (hotspot !== undefined && (!/^[\w./-]+$/.test(hotspot) || hotspot.length > MAX_HOTSPOT_CHARS)) { console.error(`Bad --hotspot (a repo path, at most ${MAX_HOTSPOT_CHARS} characters)`); return 2; }
    const issues = (option(rest, 'issues') ?? '').split(',').filter(Boolean).map((item) => Number(item.replace('#', '')));
    if (issues.some((n) => !Number.isInteger(n) || n < 1)) { console.error('Bad --issues'); return 2; }
    const line = formatState(recordRun(state, { now, rev: git(['rev-parse', '--short', MAIN_REF]), status, journey: journey ?? null, hotspot: hotspot ?? null, issues }));
    if (line.length > MAX_STATE_CHARS) { console.error(`State line is ${line.length} characters (limit ${MAX_STATE_CHARS}); use a shorter --hotspot`); return 2; }
    console.log(line);
    return 0;
  }
  console.error('Usage: tsx scripts/quality-review.ts check|record [--state="quality review: ..."|--state-file=.claude/state/NOW.md] [--now=ISO] [record: --status= --journey= --hotspot= --issues=#1,#2]');
  return 2;
};

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
