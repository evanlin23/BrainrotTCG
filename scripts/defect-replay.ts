/**
 * Escaped-defect replay (#758): does the unit gate still stop a few real defects that once shipped?
 *
 * Each case names a defect that escaped to main, the merged fix and the regression test that owns
 * it, and a narrow reversion of that fix. In a disposable worktree of HEAD (never the shared
 * checkout), the owning test file runs twice through the same Vitest config `npm run check` uses:
 * once healthy, once with the reversion applied. A case is `validated` only when the named test
 * passes healthy and fails with the reverted code for the stated reason. A faulty variant that
 * passes is `ineffective` (the gate misses the defect: the test is vacuous or a mock hides it).
 * Anything else is `inconclusive`: the test isn't discovered or is skipped, the healthy run isn't
 * clean, the reversion no longer applies, or the faulty run fails to load or fails for another
 * reason.
 *
 * Meta-cases are negative controls run the same way, with the verdict a sound harness must reach:
 * an undiscovered test, a reversion a mock removes, a reversion that breaks loading, and a stated
 * reason that doesn't match. Their own verdicts never count as a validated defect.
 *
 * No network or provider writes: the runs get no GitHub token and a dead proxy, and nothing outside
 * the temporary worktree changes except the compact evidence file the quality review reads. A run
 * that is interrupted leaves its worktree behind; the next run removes it first.
 *
 *   npx tsx scripts/defect-replay.ts            # all cases and meta-cases; exit 0 only on pass
 *   npx tsx scripts/defect-replay.ts --list     # the cases, without running anything
 *   git diff --name-only ... | npx tsx scripts/defect-replay.ts --if-gate-changed
 *                                               # CI: replay only when a listed file is in GATE_PATHS
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { isMainModule } from './main-module.ts';

export type Verdict = 'validated' | 'ineffective' | 'inconclusive';

/** A narrow reversion: `find` must occur exactly once in `file`. */
export interface Fault { file: string; find: string; replace: string }

export interface ReplayCase {
  id: string;
  /** The escaped defect and its merged fix. */
  defect: string;
  fix: string;
  invariant: string;
  gate: string;
  /** The owning regression test: its file and full name (describe titles and test title, space-joined). */
  test: { file: string; name: string };
  fault: Fault;
  /** The named test's failure must match this: the intended reason, not any red. */
  reason: RegExp;
}

/** A negative control: the verdict a sound harness reaches for it. */
export interface MetaCase extends Omit<ReplayCase, 'defect' | 'fix' | 'invariant' | 'gate'> { expect: Verdict; why: string }

const UNIT_GATE = 'unit suite (`npm run check`, CI check job)';

const PULL_VIEWER_ELSE = `          setState({
            status: 'operational',
            headline: "Couldn't verify on this device",
            message: 'Something went wrong while re-opening the pack. Try again.',
          });`;
const SETTINGS_GUARD = `            if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
                return setImportNote("That file isn't a supported Brainrot TCG save.");
            }
`;
const LEGACY_FILTER = `      const readable = stats.highestPackCards.filter(isReadablePackCard);
      const unreadable = stats.highestPackCards.filter((c) => !isReadablePackCard(c));`;
const LEGACY_UNFILTERED = `      const readable = stats.highestPackCards;
      const unreadable: unknown[] = [];`;

const LEGACY_TEST = {
  file: 'src/utils/migrations.test.ts',
  name: 'legacy record shape validation (#660) recovers null or malformed elements in legacy v1 stats highestPackCards without throwing or fabricating verified progress',
};

export const CASES: readonly ReplayCase[] = [
  {
    id: 'pull-verify-category',
    defect: '#694',
    fix: '729a8af (#926)',
    invariant: 'A verification that fails on this device (Worker, WASM, anything not a ProofError) is operational and retryable, never called a fabricated pull.',
    gate: UNIT_GATE,
    test: {
      file: 'src/components/share/PullViewerPage.test.tsx',
      name: 'PullViewerPage shows operational Worker/WASM failures with retry advice, not as a fabricated pull',
    },
    // Before the fix, any rejection rendered as an invalid pull.
    fault: {
      file: 'src/components/share/PullViewerPage.tsx',
      find: PULL_VIEWER_ELSE,
      replace: "          setState({ status: 'invalid', reason: error instanceof Error ? error.message : String(error) });",
    },
    // Vitest quotes with ' and escapes the apostrophe: the page called it invalid instead of operational.
    reason: /expected 'Not a valid pull.*' to contain 'Couldn\\'t check this pull'/,
  },
  {
    id: 'import-non-object',
    defect: '#647',
    fix: '1209cf0 (#912)',
    invariant: 'A save file that parses to null, an array or a primitive is refused with a message before any field is read or a Replace question is asked.',
    gate: UNIT_GATE,
    test: {
      file: 'src/components/pages/SettingsPage.test.tsx',
      name: 'Settings: importing a backup file rejects null, array and primitive JSON files with useful message and no replacement prompt when progress exists',
    },
    // Before the fix, handleFileChange read `player` and `stats` straight off the parsed value.
    fault: { file: 'src/components/pages/SettingsPage.tsx', find: SETTINGS_GUARD, replace: '' },
    // The null file reached the storage check and was reported as a storage failure.
    reason: /expected 'Couldn\\'t read browser storage.*' to be 'That file isn\\'t a supported Brainrot/,
  },
  {
    id: 'legacy-stats-shape',
    defect: '#660',
    fix: 'c99a523 (#905)',
    invariant: "Malformed legacy stats (null pack cards) migrate without throwing, keep the unreadable entries aside and don't fabricate a best pack.",
    gate: UNIT_GATE,
    test: LEGACY_TEST,
    // Before the fix, every highestPackCards element was hydrated as a card.
    fault: { file: 'src/utils/migrations.ts', find: LEGACY_FILTER, replace: LEGACY_UNFILTERED },
    reason: /to not throw an error but 'TypeError: Cannot read properties of/,
  },
];

export const META: readonly MetaCase[] = [
  {
    id: 'meta-not-discovered',
    expect: 'inconclusive',
    why: 'a test name that matches nothing proves nothing',
    test: { file: LEGACY_TEST.file, name: 'legacy record shape validation (#660) a test that does not exist (#758 meta)' },
    fault: CASES[2].fault,
    reason: CASES[2].reason,
  },
  {
    id: 'meta-mocked-away',
    expect: 'ineffective',
    why: 'main.test.tsx mocks the migrations, so the #660 reversion never reaches it',
    test: { file: 'src/main.test.tsx', name: 'startup migration failure containment (#660, #659) renders crash fallback and halts before mounting ordinary app when runMigrations throws' },
    fault: CASES[2].fault,
    reason: CASES[2].reason,
  },
  {
    id: 'meta-load-error',
    expect: 'inconclusive',
    why: 'a reversion that breaks the module fails for setup, not the defect',
    test: LEGACY_TEST,
    fault: { file: 'src/utils/migrations.ts', find: LEGACY_FILTER, replace: `${LEGACY_UNFILTERED} (` },
    reason: CASES[2].reason,
  },
  {
    id: 'meta-wrong-reason',
    expect: 'inconclusive',
    why: 'a red test is not enough: it must fail for the stated reason',
    test: LEGACY_TEST,
    fault: CASES[2].fault,
    reason: /a failure message nothing produces \(#758 meta\)/,
  },
];

/**
 * What the replay guards: the unit gate's config and setup, this harness, and each case's owning
 * test and fixed code. CI runs the replay on a pull request that changes any of them.
 */
export const GATE_PATHS: readonly string[] = [...new Set([
  'vite.config.ts', 'src/test/', 'scripts/defect-replay.ts', 'scripts/defect-replay.test.ts',
  ...[...CASES, ...META].flatMap((c) => [c.test.file, c.fault.file]),
])];

/** The changed files (one per line) that touch the gate. */
export const gateChanges = (changed: string): string[] =>
  changed.split('\n').map((line) => line.trim()).filter((file) => GATE_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p)));

// ---- Classification (pure) ----

/** The part of Vitest's JSON reporter output this reads. */
export interface VitestReport {
  testResults: { name: string; status: string; message?: string; assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[];
}
export interface Run { exit: number | null; report: VitestReport | null }
export interface Outcome { verdict: Verdict; detail: string }

const clip = (text: string, n = 160) => stripVTControlCharacters(text).replace(/\s+/g, ' ').trim().slice(0, n);

const find = (run: Run, test: ReplayCase['test']) => {
  const file = run.report?.testResults.find((r) => r.name.replaceAll('\\', '/').endsWith(`/${test.file}`));
  return { file, result: file?.assertionResults.find((a) => a.fullName === test.name) };
};

/** Judges a case from its healthy run and its faulty run (null when the reversion didn't apply). */
export const classify = (c: Pick<ReplayCase, 'test' | 'reason'>, healthy: Run, faulty: Run | null, applied: string | null): Outcome => {
  const inconclusive = (detail: string): Outcome => ({ verdict: 'inconclusive', detail });
  if (!healthy.report) return inconclusive('healthy run wrote no report');
  const h = find(healthy, c.test);
  if (!h.file) return inconclusive('test file not discovered by the Vitest config');
  if (!h.result) return inconclusive('test not discovered');
  if (h.result.status !== 'passed') return inconclusive(`healthy control is ${h.result.status}`);
  if (healthy.exit !== 0) return inconclusive('healthy run is not clean (other failures or unhandled errors)');
  if (applied) return inconclusive(`reversion did not apply: ${applied}`);
  if (!faulty?.report) return inconclusive('faulty run wrote no report');
  const f = find(faulty, c.test);
  if (!f.result) return inconclusive(`faulty run did not load the test: ${clip(f.file?.message ?? 'no result')}`);
  if (f.result.status === 'passed') return { verdict: 'ineffective', detail: 'faulty variant passes: the gate misses this defect' };
  if (f.result.status !== 'failed') return inconclusive(`faulty test is ${f.result.status}`);
  const message = f.result.failureMessages.join('\n');
  if (!c.reason.test(message)) return inconclusive(`fails for another reason: ${clip(message)}`);
  return { verdict: 'validated', detail: clip(message.split('\n')[0]) };
};

export interface CaseResult { id: string; verdict: Verdict; detail: string; expect?: Verdict }
/** `revision` is the full commit replayed: the quality review counts a pass only for a commit on main. */
export interface Summary { status: 'pass' | 'fail' | 'blocked'; date: string; detail: string; revision: string }

/**
 * pass: every case validated and every meta-case reached its expected verdict. fail: a case the gate
 * misses, or a meta-case the harness judged wrongly (the harness itself can't be trusted). blocked:
 * otherwise (an inconclusive case: no evidence either way).
 */
export const summarize = (results: CaseResult[], date: string, revision: string): Summary => {
  const cases = results.filter((r) => !r.expect);
  const meta = results.filter((r) => r.expect);
  const missed = cases.filter((r) => r.verdict === 'ineffective').map((r) => r.id);
  const wrongMeta = meta.filter((r) => r.verdict !== r.expect).map((r) => r.id);
  const unknown = cases.filter((r) => r.verdict === 'inconclusive').map((r) => r.id);
  const validated = cases.filter((r) => r.verdict === 'validated').length;
  const status = missed.length || wrongMeta.length || !cases.length ? 'fail' : unknown.length ? 'blocked' : 'pass';
  const notes = [
    `${validated}/${cases.length} validated at ${revision.slice(0, 7)}`,
    `meta ${meta.length - wrongMeta.length}/${meta.length}`,
    ...(missed.length ? [`missed: ${missed.join(',')}`] : []),
    ...(wrongMeta.length ? [`harness wrong: ${wrongMeta.join(',')}`] : []),
    ...(unknown.length ? [`inconclusive: ${unknown.join(',')}`] : []),
  ];
  return { status, date, detail: notes.join('; '), revision };
};

// ---- Running ----

const git = (cwd: string, args: string[]) => {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (ran.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${clip(ran.stderr)}`);
  return ran.stdout.trim();
};

/** Vitest on one file in the worktree, offline and without credentials. */
const vitest = (tree: string, file: string, out: string): Run => {
  rmSync(out, { force: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '', CI: '1' };
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'NODE_AUTH_TOKEN', 'npm_config_proxy', 'npm_config_https_proxy']) delete env[key];
  const ran = spawnSync('npx', ['vitest', 'run', file, '--testTimeout=15000', '--reporter=json', `--outputFile=${out}`], { cwd: tree, env, encoding: 'utf8', timeout: 180_000 });
  try {
    return { exit: ran.status, report: JSON.parse(readFileSync(out, 'utf8')) as VitestReport };
  } catch {
    return { exit: ran.status, report: null };
  }
};

/** Applies the fault in the worktree; returns why it couldn't, or null. */
const applyFault = (tree: string, fault: Fault): string | null => {
  const target = path.join(tree, fault.file);
  if (!existsSync(target)) return `${fault.file} is gone`;
  const text = readFileSync(target, 'utf8');
  const count = text.split(fault.find).length - 1;
  if (count !== 1) return `${fault.file} has the fixed code ${count} times, not once`;
  writeFileSync(target, text.replace(fault.find, () => fault.replace));
  return null;
};

const SCRATCH = /^defect-replay-(\d+)-[^/\\]+$/;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Removes what an interrupted run left in `tmp` (its worktree, temp dir and the repository's
 * worktree entry). Each run's directory names its process, so a run still going is left alone.
 */
export const sweepStale = (repo: string, tmp = os.tmpdir(), alive: (pid: number) => boolean = isAlive): string[] => {
  const stale = readdirSync(tmp).filter((name) => {
    const pid = SCRATCH.exec(name)?.[1];
    return pid !== undefined && !alive(Number(pid));
  });
  for (const name of stale) {
    spawnSync('git', ['worktree', 'remove', '--force', path.join(tmp, name, 'tree')], { cwd: repo });
    rmSync(path.join(tmp, name), { recursive: true, force: true });
  }
  spawnSync('git', ['worktree', 'prune'], { cwd: repo });
  return stale;
};

export const replay = (repo: string, cases: readonly (ReplayCase | MetaCase)[], log: (line: string) => void = () => {}, tmp = os.tmpdir()): { revision: string; results: CaseResult[] } => {
  const revision = git(repo, ['rev-parse', 'HEAD']);
  for (const name of sweepStale(repo, tmp)) log(`removed ${name}, left by an interrupted run`);
  const scratch = mkdtempSync(path.join(tmp, `defect-replay-${process.pid}-`));
  const tree = path.join(scratch, 'tree');
  git(repo, ['worktree', 'add', '--quiet', '--detach', tree, revision]);
  try {
    symlinkSync(path.join(repo, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
    const healthy = new Map<string, Run>();
    const results: CaseResult[] = [];
    cases.forEach((c, i) => {
      git(tree, ['checkout', '--quiet', '--', '.']);
      if (!healthy.has(c.test.file)) healthy.set(c.test.file, vitest(tree, c.test.file, path.join(scratch, `healthy-${i}.json`)));
      const applied = applyFault(tree, c.fault);
      const faulty = applied ? null : vitest(tree, c.test.file, path.join(scratch, `faulty-${i}.json`));
      const outcome = classify(c, healthy.get(c.test.file)!, faulty, applied);
      const result: CaseResult = { id: c.id, ...outcome, ...('expect' in c ? { expect: c.expect } : {}) };
      log(`${result.id}: ${result.verdict}${result.expect ? ` (expected ${result.expect})` : ''}: ${result.detail}`);
      results.push(result);
    });
    return { revision, results };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: repo });
    rmSync(scratch, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: repo });
  }
};

export const EVIDENCE_PATH = 'test-results/quality-evidence/defect-replay.json';

/** What the evidence file says while a run is going, and after one that never finished. */
export const started = (revision: string, date: string): Summary =>
  ({ status: 'blocked', date, detail: `started at ${revision.slice(0, 7)}, no result: running or interrupted`, revision });

const writeEvidence = (summary: Summary) => {
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(summary)}\n`);
};

const main = (argv: string[]): number => {
  const repo = process.cwd();
  if (argv.includes('--list')) {
    for (const c of CASES) console.log(`${c.id} ${c.defect} fix ${c.fix}: ${c.test.file} — ${c.invariant}`);
    for (const m of META) console.log(`${m.id} (expect ${m.expect}): ${m.why}`);
    return 0;
  }
  if (argv.includes('--if-gate-changed')) {
    const touched = gateChanges(readFileSync(0, 'utf8'));
    if (!touched.length) {
      console.log('defect replay: not run, no changed file touches the gate (GATE_PATHS)');
      return 0;
    }
    console.log(`defect replay: the gate changed (${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ', ...' : ''})`);
  }
  const date = new Date().toISOString().slice(0, 10);
  // Until this run finishes, an older result must not read as current: a crash leaves this behind.
  writeEvidence(started(git(repo, ['rev-parse', 'HEAD']), date));
  const { revision, results } = replay(repo, [...CASES, ...META], console.log);
  const summary = summarize(results, date, revision);
  writeEvidence(summary);
  console.log(`defect replay: ${summary.status}: ${summary.detail} (${EVIDENCE_PATH})`);
  return summary.status === 'pass' ? 0 : 1;
};

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
