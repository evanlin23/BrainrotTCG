import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from './main-module.ts';

/**
 * Operational health from signals that already exist (#715): GitHub Actions run results for the
 * deploy and the Hall of Fame inbox, and the counts-only summary each inbox run uploads. There is no
 * server, no new service and no secret: `.github/workflows/ops-health.yml` runs this with a read-only
 * token and keeps one issue per unhealthy condition. Policy, conditions and runbook:
 * docs/DEVELOPMENT.md (Operational health).
 *
 * Rules, all enforced here:
 * - Every condition is ok, unhealthy or unknown. A failed, cancelled, timed-out, skipped or absent
 *   run is never ok; a run that is still going, or data that couldn't be read, is unknown (it neither
 *   opens nor closes an issue).
 * - It reads at most RUN_LIMIT runs per workflow and SUMMARY_LIMIT inbox summaries, so what it can't
 *   see is unknown, not zero: unseen work is not an empty backlog.
 * - Output holds workflow names, run ids, fixed outcome words, times, short revisions and counts
 *   only. Anything else in GitHub's answers or a summary (free text, URLs, names) is dropped.
 * - Time and `gh` are injected, so tests are deterministic and never touch a real repository.
 */

/** Runs read per workflow, newest first: one `gh run list` call each. */
export const RUN_LIMIT = 20;
/** Inbox summaries downloaded per report: one `gh run download` call each. */
export const SUMMARY_LIMIT = 6;
/** Newest successful inbox runs that must all have deferred work before deferral counts as sustained. */
export const DEFERRAL_RUNS = 3;
/** How long main's newest commit may wait for a successful deploy (a deploy takes about 15 minutes). */
export const DEPLOY_GRACE_S = 3 * 3600;
/**
 * How old the last successful inbox run may be. A Cloudflare Worker dispatches it every 15 minutes
 * and GitHub's own schedule is best-effort, so this allows several missed or late runs.
 */
export const INBOX_STALE_S = 2 * 3600;

export const DEPLOY = 'deploy.yml';
export const INBOX = 'hall-of-fame-inbox.yml';
/** Shown with their latest result, never turned into issues: they report themselves or only run by hand. */
export const REPORT_ONLY = ['hall-of-fame.yml', 'test-order.yml', 'performance-baseline.yml'] as const;
export const INBOX_SUMMARY_PATH = 'hof-inbox-summary.json';
export const INBOX_SUMMARY_ARTIFACT = 'hof-inbox-summary';
export const OUTPUT_PATH = 'ops-health.json';

// ---- The inbox's run summary (written by scripts/hall-of-fame.ts inbox, uploaded as an artifact) ----

export const INBOX_STAGES = ['relays', 'issues', 'list', 'process', 'done'] as const;
export type InboxStage = (typeof INBOX_STAGES)[number];
export const INBOX_STOPS = ['budget', 'filing-cap', 'write-failed'] as const;
export type InboxStop = (typeof INBOX_STOPS)[number];

/** Counts only: no events, proofs, names, relay addresses or error text. */
export interface InboxSummary {
  v: 1;
  /** The commit the run ran. */
  rev: string;
  run: number;
  /** When the run finished. */
  at: string;
  /** The last stage it reached; `done` when it finished. A provider failure shows as the stage it stopped in. */
  stage: InboxStage;
  outcome: 'ok' | 'error';
  relays: { total: number; failed: number };
  /** Events read from the relays (past the window or paging limit they are never seen). */
  read: number;
  /** Pulls re-derived, out of INBOX_BUDGET. */
  checked: number;
  added: number;
  /** Events left for the next run. */
  deferred: number;
  /** Why it left them: budget spent, filing cap reached, or a GitHub write failed. */
  stop: InboxStop | null;
  /** Age of the oldest event left for later, by the sender's own timestamp, so only a hint. */
  oldestDeferredAgeS: number | null;
}

const SHA = /^[0-9a-f]{40}$/;
const MAX_COUNT = 1_000_000;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT ? (value as number) : null);
const runId = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null);
const time = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null => (values.includes(value as T) ? (value as T) : null);

/** A summary as the inbox writes it, or null if any field is missing or out of shape. */
export const parseInboxSummary = (value: unknown): InboxSummary | null => {
  if (!isObject(value) || value.v !== 1 || !isObject(value.relays)) return null;
  const rev = typeof value.rev === 'string' && SHA.test(value.rev) ? value.rev : null;
  const run = runId(value.run);
  const at = time(value.at);
  const stage = oneOf(INBOX_STAGES, value.stage);
  const outcome = oneOf(['ok', 'error'] as const, value.outcome);
  const [total, failed, read, checked, added, deferred] = [value.relays.total, value.relays.failed, value.read, value.checked, value.added, value.deferred].map(count);
  const stop = value.stop === null ? null : oneOf(INBOX_STOPS, value.stop);
  const age = value.oldestDeferredAgeS === null ? null : count(value.oldestDeferredAgeS);
  if (!rev || !run || !at || !stage || !outcome || total === null || failed === null || failed > total) return null;
  if (read === null || checked === null || added === null || deferred === null) return null;
  if ((value.stop !== null && !stop) || (value.oldestDeferredAgeS !== null && age === null)) return null;
  return { v: 1, rev, run, at, stage, outcome, relays: { total, failed }, read, checked, added, deferred, stop, oldestDeferredAgeS: age };
};

// ---- Workflow runs ----

const STATUSES = ['completed', 'in_progress', 'queued', 'requested', 'waiting', 'pending'] as const;
type RunStatus = (typeof STATUSES)[number] | 'other';
const CONCLUSIONS = ['success', 'failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'stale', 'action_required', 'startup_failure'] as const;
type Conclusion = (typeof CONCLUSIONS)[number] | 'other';

export interface Run { id: number; status: RunStatus; conclusion: Conclusion | null; createdAt: string; updatedAt: string; sha: string }

/** `gh run list --json databaseId,status,conclusion,createdAt,updatedAt,headSha`, newest first; null if it isn't that. */
export const parseRuns = (value: unknown): Run[] | null => {
  if (!Array.isArray(value)) return null;
  const runs: Run[] = [];
  for (const item of value) {
    if (!isObject(item)) return null;
    const id = runId(item.databaseId);
    const createdAt = time(item.createdAt);
    const updatedAt = time(item.updatedAt);
    const sha = typeof item.headSha === 'string' && SHA.test(item.headSha) ? item.headSha : null;
    if (!id || !createdAt || !updatedAt || !sha) return null;
    const status = oneOf(STATUSES, item.status) ?? 'other';
    const conclusion = status === 'completed' ? (oneOf(CONCLUSIONS, item.conclusion) ?? 'other') : null;
    runs.push({ id, status, conclusion, createdAt, updatedAt, sha });
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
};

// ---- Conditions ----

export type State = 'ok' | 'unhealthy' | 'unknown';
export const CONDITIONS = {
  'deploy-failing': 'Ops health: the latest deploy of main did not succeed',
  'deploy-behind': "Ops health: main's newest commit is not deployed",
  'inbox-failing': 'Ops health: the latest Hall of Fame inbox run did not succeed',
  'inbox-stale': 'Ops health: the Hall of Fame inbox has not succeeded recently',
  'inbox-deferring': 'Ops health: the Hall of Fame inbox keeps deferring work',
} as const;
export type ConditionKey = keyof typeof CONDITIONS;
export interface Condition { key: ConditionKey; title: string; state: State; reason: string }

const short = (sha: string) => sha.slice(0, 7);
const ageText = (seconds: number) => (seconds < 5400 ? `${Math.round(seconds / 60)} min` : seconds < 172_800 ? `${Math.round(seconds / 3600)} h` : `${Math.round(seconds / 86_400)} d`);
const age = (now: Date, at: string) => Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 1000));
const runText = (run: Run, now: Date) => `run ${run.id} (${short(run.sha)}) ${run.conclusion ?? run.status} ${ageText(age(now, run.updatedAt))} ago`;
const condition = (key: ConditionKey, state: State, reason: string): Condition => ({ key, title: CONDITIONS[key], state, reason });

/** The newest completed run decides, unless a newer one is still going (then it's unknown until that one ends). */
export const latestResult = (key: ConditionKey, runs: Run[] | null, now: Date): Condition => {
  if (!runs) return condition(key, 'unknown', "couldn't list the workflow's runs");
  const latest = runs.find((r) => r.status === 'completed');
  if (!latest) return condition(key, 'unknown', `no completed run among the newest ${runs.length}`);
  if (latest.conclusion === 'success') return condition(key, 'ok', `latest is ${runText(latest, now)}`);
  if (runs.some((r) => r.status !== 'completed' && r.createdAt > latest.createdAt)) return condition(key, 'unknown', `latest completed is ${runText(latest, now)}; a newer run is still going`);
  return condition(key, 'unhealthy', `latest completed is ${runText(latest, now)}`);
};

export interface Head { sha: string; date: string }

/** main's newest commit has a successful deploy, or is younger than DEPLOY_GRACE_S. */
export const deployBehind = (runs: Run[] | null, head: Head | null, now: Date): Condition => {
  const key = 'deploy-behind';
  if (!runs || !head) return condition(key, 'unknown', runs ? "couldn't read main's newest commit" : "couldn't list the workflow's runs");
  const deployed = runs.find((r) => r.conclusion === 'success' && r.sha === head.sha);
  if (deployed) return condition(key, 'ok', `${short(head.sha)} deployed by ${runText(deployed, now)}`);
  const waited = age(now, head.date);
  const last = runs.find((r) => r.conclusion === 'success');
  const lastText = last ? `the last successful deploy is ${runText(last, now)}` : `no successful deploy among the newest ${runs.length} runs`;
  if (waited < DEPLOY_GRACE_S) return condition(key, 'unknown', `${short(head.sha)} landed ${ageText(waited)} ago, inside the ${ageText(DEPLOY_GRACE_S)} grace; ${lastText}`);
  return condition(key, 'unhealthy', `${short(head.sha)} landed ${ageText(waited)} ago and has no successful deploy; ${lastText}`);
};

/** The last successful inbox run is newer than INBOX_STALE_S. */
export const inboxStale = (runs: Run[] | null, now: Date): Condition => {
  const key = 'inbox-stale';
  if (!runs) return condition(key, 'unknown', "couldn't list the workflow's runs");
  const last = runs.find((r) => r.conclusion === 'success');
  if (!last) return condition(key, 'unhealthy', `no successful run among the newest ${runs.length}`);
  const since = age(now, last.updatedAt);
  return condition(key, since > INBOX_STALE_S ? 'unhealthy' : 'ok', `last success is ${runText(last, now)} (limit ${ageText(INBOX_STALE_S)})`);
};

export interface Intake {
  /** Successful runs whose summaries were looked for, newest first, and what was found for each. */
  runs: { run: Run; summary: InboxSummary | null }[];
}

/**
 * Sustained deferral: the newest DEFERRAL_RUNS successful runs all left work for later. The newest
 * run draining its queue is ok; anything not observed (an expired or missing summary) is unknown.
 */
export const inboxDeferring = (intake: Intake | null): Condition => {
  const key = 'inbox-deferring';
  if (!intake) return condition(key, 'unknown', "couldn't list the workflow's runs");
  const newest = intake.runs.slice(0, DEFERRAL_RUNS);
  const observed = newest.filter((r) => r.summary);
  if (newest[0]?.summary && newest[0].summary.deferred === 0) return condition(key, 'ok', `run ${newest[0].run.id} left nothing for later`);
  if (newest.length === DEFERRAL_RUNS && observed.length === DEFERRAL_RUNS && observed.every((r) => r.summary!.deferred > 0)) {
    const stops = [...new Set(observed.map((r) => r.summary!.stop ?? 'unrecorded'))].join(', ');
    const deferred = observed.map((r) => r.summary!.deferred).join(', ');
    return condition(key, 'unhealthy', `the newest ${DEFERRAL_RUNS} successful runs each left work for later (${deferred} events; stopped by ${stops})`);
  }
  return condition(key, 'unknown', `observed ${observed.length} of the newest ${DEFERRAL_RUNS} successful runs' summaries`);
};

// ---- The report ----

export interface WorkflowRow { file: string; listed: number | null; latest: { id: number; result: string; at: string; rev: string } | null; lastSuccessAt: string | null }
export interface Report {
  v: 1;
  at: string;
  head: { rev: string; at: string } | null;
  conditions: Condition[];
  workflows: WorkflowRow[];
  intake: {
    /** Summaries found, out of those looked for (SUMMARY_LIMIT newest successful runs at most). */
    observed: number;
    looked: number;
    latest: InboxSummary | null;
    maxDeferred: number | null;
    maxQueueAgeS: number | null;
    relayFailures: number | null;
  };
}

const row = (file: string, runs: Run[] | null): WorkflowRow => {
  const latest = runs?.find((r) => r.status === 'completed') ?? runs?.[0] ?? null;
  return {
    file,
    listed: runs ? runs.length : null,
    latest: latest && { id: latest.id, result: latest.conclusion ?? latest.status, at: latest.updatedAt, rev: short(latest.sha) },
    lastSuccessAt: runs?.find((r) => r.conclusion === 'success')?.updatedAt ?? null,
  };
};

export interface Inputs { now: Date; head: Head | null; runs: Record<string, Run[] | null>; intake: Intake | null }

export const buildReport = ({ now, head, runs, intake }: Inputs): Report => {
  const deploy = runs[DEPLOY] ?? null;
  const inbox = runs[INBOX] ?? null;
  const summaries = (intake?.runs ?? []).flatMap((r) => (r.summary ? [r.summary] : []));
  const max = (values: (number | null)[]) => (values.some((v) => v !== null) ? Math.max(...values.filter((v): v is number => v !== null)) : null);
  return {
    v: 1,
    at: now.toISOString(),
    head: head && { rev: short(head.sha), at: head.date },
    conditions: [latestResult('deploy-failing', deploy, now), deployBehind(deploy, head, now), latestResult('inbox-failing', inbox, now), inboxStale(inbox, now), inboxDeferring(intake)],
    workflows: [DEPLOY, INBOX, ...REPORT_ONLY].map((file) => row(file, runs[file] ?? null)),
    intake: {
      observed: summaries.length,
      looked: intake?.runs.length ?? 0,
      latest: summaries[0] ?? null,
      maxDeferred: max(summaries.map((s) => s.deferred)),
      maxQueueAgeS: max(summaries.map((s) => s.oldestDeferredAgeS)),
      relayFailures: summaries.length ? summaries.reduce((sum, s) => sum + s.relays.failed, 0) : null,
    },
  };
};

const cell = (value: string | number | null) => (value === null ? 'n/a' : String(value));

/** The run's step summary. */
export const formatReport = (report: Report): string => {
  const { intake } = report;
  return [
    '### Operational health',
    '',
    `Checked ${report.at}; main is ${report.head ? `\`${report.head.rev}\` (${report.head.at})` : 'unknown'}. Unknown neither opens nor closes an issue.`,
    '',
    '| Condition | State | Why |',
    '| --- | --- | --- |',
    ...report.conditions.map((c) => `| \`${c.key}\` | ${c.state} | ${c.reason} |`),
    '',
    `| Workflow | Runs read | Latest | Last success |`,
    '| --- | --- | --- | --- |',
    ...report.workflows.map((w) => `| ${w.file} | ${cell(w.listed)} | ${w.latest ? `${w.latest.id} ${w.latest.result} ${w.latest.at} \`${w.latest.rev}\`` : 'none'} | ${cell(w.lastSuccessAt)} |`),
    '',
    `Inbox summaries: ${intake.observed} of ${intake.looked} looked for (artifacts expire after 3 days; a run that failed early writes none). ` +
      `Most deferred: ${cell(intake.maxDeferred)}; oldest deferred event: ${intake.maxQueueAgeS === null ? 'n/a' : ageText(intake.maxQueueAgeS)}; relay read failures: ${cell(intake.relayFailures)}. ` +
      'Events past the relay window or paging limit are never read, so a zero here is not an empty backlog.',
    '',
  ].join('\n');
};

// ---- Reading GitHub through `gh` ----

/** Runs `gh` with these arguments and returns its stdout; throws on failure. */
export type Gh = (args: string[]) => string;
const realGh: Gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 });

const tryJson = (gh: Gh, args: string[]): unknown => {
  try {
    return JSON.parse(gh(args));
  } catch {
    return undefined;
  }
};

export const listRuns = (gh: Gh, file: string): Run[] | null =>
  parseRuns(tryJson(gh, ['run', 'list', '--workflow', file, '--branch', 'main', '--limit', String(RUN_LIMIT), '--json', 'databaseId,status,conclusion,createdAt,updatedAt,headSha']));

export const readHead = (gh: Gh): Head | null => {
  const head = tryJson(gh, ['api', 'repos/{owner}/{repo}/commits/main', '--jq', '{sha: .sha, date: .commit.committer.date}']);
  if (!isObject(head) || typeof head.sha !== 'string' || !SHA.test(head.sha)) return null;
  const date = time(head.date);
  return date ? { sha: head.sha, date } : null;
};

/** The summary a run uploaded, or null if it has none (expired, failed early) or it isn't that run's. */
export const readSummary = (gh: Gh, run: Run): InboxSummary | null => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ops-health-'));
  try {
    gh(['run', 'download', String(run.id), '--name', INBOX_SUMMARY_ARTIFACT, '--dir', dir]);
    const summary = parseInboxSummary(JSON.parse(readFileSync(path.join(dir, INBOX_SUMMARY_PATH), 'utf8')));
    return summary && summary.run === run.id && summary.rev === run.sha ? summary : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const collect = (gh: Gh, now: Date): Inputs => {
  const runs = Object.fromEntries([DEPLOY, INBOX, ...REPORT_ONLY].map((file) => [file, listRuns(gh, file)]));
  const inbox = runs[INBOX];
  const intake = inbox && { runs: inbox.filter((r) => r.conclusion === 'success').slice(0, SUMMARY_LIMIT).map((run) => ({ run, summary: readSummary(gh, run) })) };
  return { now, head: readHead(gh), runs, intake };
};

/** Writes ops-health.json, prints the step summary and sets `conditions` for the issue job. */
export const main = (gh: Gh = realGh, now = new Date()): number => {
  const report = buildReport(collect(gh, now));
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 1)}\n`);
  console.log(formatReport(report));
  if (process.env.GITHUB_OUTPUT) {
    const conditions = report.conditions.map(({ key, title, state, reason }) => ({ key, title, state, reason }));
    appendFileSync(process.env.GITHUB_OUTPUT, `conditions=${JSON.stringify(conditions)}\n`);
  }
  return 0;
};

if (isMainModule(import.meta.url)) process.exitCode = main();
