/**
 * Read-only branch inventory for branch hygiene (#710, docs/DEVELOPMENT.md, Branch hygiene). It
 * classifies every branch and lists the ones that are safe to retire; it never deletes, pushes or
 * writes to GitHub. Only the Claude coordinator deletes, from a confirmed list (see the doc).
 *
 *   npx tsx scripts/branch-inventory.ts --git-dir=<bare clone> --pulls=<pulls.json> [--keep=<file>]
 *     [--protected=main,...] [--now=<ISO time>] [--confirm=<candidates file>] [--evidence]
 *
 * --git-dir is a clone whose refs/heads/* mirror origin and that has every refs/pull/<n>/head
 * fetched. --pulls is the JSON of GitHub's "list pull requests" (state=all), one array or a list
 * of pages. --keep lists branch names to keep (active sessions, holds), one per line, `#` comments
 * allowed. --confirm takes a batch of at most 25 of an earlier run's candidate lines and prints only
 * the ones whose branch, tip and evidence are unchanged now. --evidence, with --confirm only, writes
 * the quality-review signal to test-results/quality-evidence/ under the working directory.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isMainModule } from './main-module.ts';

export type Branch = { name: string; tip: string; committedAt: string };
export type Pull = {
  number: number;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at: string | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } | null };
};

/** Why a branch stays, or `candidate` when its work is preserved by a merged PR. In precedence order. */
export const CATEGORIES = [
  'protected', 'open-pr', 'kept', 'dependency', 'recent', 'candidate', 'unverified', 'merged-newer', 'closed-unmerged', 'no-pr',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const REASONS: Record<Category, string> = {
  protected: 'default or protected branch',
  'open-pr': 'head or base of an open or draft PR (stacked bases included)',
  kept: 'on the keep list: active work, a hold or a documented reference',
  dependency: 'dependency bot branch; the bot manages it',
  recent: 'tip committed in the last day (claude/batch-* in the last two days)',
  candidate: 'tip is a merged PR head, or an ancestor of one: the work is merged and GitHub keeps refs/pull/<n>/head',
  unverified: 'a merged PR head holds the tip, but the clone has no refs/pull/<n>/head at that head: fetch it and re-run',
  'merged-newer': 'merged PR, but the branch has commits after the merged head',
  'closed-unmerged': 'closed PR, never merged: may hold unique work',
  'no-pr': 'no PR from this repository: unknown intent',
};

export type Classified = Branch & { category: Category; pr?: number; mergedHead?: string; note?: string };

export type Options = {
  repo: string;
  defaultBranch: string;
  protectedBranches: ReadonlySet<string>;
  keep: ReadonlySet<string>;
  now: Date;
  /** True when commit `a` is `b` or an ancestor of it. Any git failure must answer false. */
  isAncestor: (a: string, b: string) => boolean;
  /** The clone's refs/pull/<n>/head, the copy a restore comes from, or undefined when it isn't fetched. */
  pullHead: (pr: number) => string | undefined;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const ownHead = (pull: Pull, repo: string) => pull.head.repo?.full_name === repo;

/**
 * One category per branch. A merged PR counts only when the tip is its merged head or an ancestor of
 * it, and only as a candidate when the clone's refs/pull/<n>/head is that merged head.
 */
export const classify = (branches: readonly Branch[], pulls: readonly Pull[], options: Options): Classified[] => {
  const openRefs = new Set<string>();
  for (const pull of pulls) {
    if (pull.state !== 'open') continue;
    if (ownHead(pull, options.repo)) openRefs.add(pull.head.ref);
    if (pull.base.repo?.full_name === options.repo) openRefs.add(pull.base.ref);
  }
  return branches.map((branch): Classified => {
    const { name } = branch;
    if (name === options.defaultBranch || options.protectedBranches.has(name)) return { ...branch, category: 'protected' };
    if (openRefs.has(name)) return { ...branch, category: 'open-pr' };
    if (options.keep.has(name)) return { ...branch, category: 'kept' };
    if (name.startsWith('dependabot/')) return { ...branch, category: 'dependency' };
    const age = options.now.getTime() - Date.parse(branch.committedAt);
    if (!(age >= DAY_MS) || (name.startsWith('claude/batch-') && age < 2 * DAY_MS)) return { ...branch, category: 'recent' };
    const own = pulls.filter((pull) => ownHead(pull, options.repo) && pull.head.ref === name);
    const merged = own.filter((pull) => pull.merged_at !== null).sort((a, b) => b.number - a.number);
    const holding = merged.filter((pull) => pull.head.sha === branch.tip || options.isAncestor(branch.tip, pull.head.sha));
    const restorable = holding.find((pull) => options.pullHead(pull.number) === pull.head.sha);
    if (restorable) return { ...branch, category: 'candidate', pr: restorable.number, mergedHead: restorable.head.sha };
    if (holding.length > 0) return { ...branch, category: 'unverified', pr: holding[0].number, mergedHead: holding[0].head.sha };
    if (merged.length > 0) return { ...branch, category: 'merged-newer', pr: merged[0].number, mergedHead: merged[0].head.sha };
    const tipInMain = options.isAncestor(branch.tip, options.defaultBranch) ? `tip is already in ${options.defaultBranch}` : undefined;
    if (own.length > 0) {
      const latest = Math.max(...own.map((pull) => pull.number));
      return { ...branch, category: 'closed-unmerged', pr: latest, ...(tipInMain ? { note: tipInMain } : {}) };
    }
    return { ...branch, category: 'no-pr', ...(tipInMain ? { note: tipInMain } : {}) };
  });
};

/** `branch|tip|merged-PR#|merged-head`: what the coordinator verifies and deletes from. */
export const candidateLine = (branch: Classified) => `${branch.name}|${branch.tip}|${branch.pr}|${branch.mergedHead}`;

/**
 * Re-checks an earlier candidate list against a fresh inventory. A line is confirmed only when the
 * branch is still a candidate with the same tip, PR and merged head; anything else is skipped with
 * the reason, and is reclassified by the next inventory instead of being deleted.
 */
export const confirm = (lines: readonly string[], now: readonly Classified[]) => {
  const byName = new Map(now.map((branch) => [branch.name, branch]));
  const confirmed: string[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    const [name] = line.split('|');
    const current = byName.get(name ?? '');
    if (!current) skipped.push(`${line} (branch is gone)`);
    else if (current.category !== 'candidate') skipped.push(`${line} (now ${current.category})`);
    else if (candidateLine(current) !== line) skipped.push(`${line} (tip or evidence changed: ${candidateLine(current)})`);
    else confirmed.push(line);
  }
  return { confirmed, skipped };
};

export const report = (classified: readonly Classified[], pullCount: number, takenAt: string) => {
  const lines = [
    `# Branch inventory, ${takenAt}`,
    '',
    `${classified.length} branches, ${pullCount} pull requests. Read-only: nothing was deleted.`,
    '',
    '| Category | Branches | Why |',
    '| --- | ---: | --- |',
    ...CATEGORIES.map((category) => `| ${category} | ${classified.filter((branch) => branch.category === category).length} | ${REASONS[category]} |`),
  ];
  for (const category of CATEGORIES) {
    const members = classified.filter((branch) => branch.category === category).sort((a, b) => a.name.localeCompare(b.name));
    if (members.length === 0) continue;
    lines.push('', `## ${category} (${members.length})`, '');
    if (category === 'candidate') {
      lines.push('`branch|tip|merged-PR#|merged-head`', '', '```', ...members.map(candidateLine), '```');
      continue;
    }
    lines.push(...members.map((branch) => {
      const pr = branch.pr === undefined ? '' : ` #${branch.pr}`;
      const note = branch.note ? `, ${branch.note}` : '';
      return `- ${branch.name} ${branch.tip.slice(0, 7)} ${branch.committedAt.slice(0, 10)}${pr}${note}`;
    }));
  }
  return lines.join('\n');
};

// --- Command line ----------------------------------------------------------------------------

export type GitRun = (args: string[]) => string;

export const readBranches = (run: GitRun): Branch[] =>
  run(['for-each-ref', '--format=%(refname:strip=2) %(objectname) %(committerdate:iso-strict)', 'refs/heads'])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, tip, committedAt] = line.split(' ');
      return { name: name!, tip: tip!, committedAt: committedAt! };
    });

export const ancestry = (run: GitRun) => (a: string, b: string) => {
  try {
    run(['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch { return false; }
};

export const readPullHeads = (run: GitRun) => {
  const heads = new Map<number, string>();
  for (const line of run(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/pull']).split('\n')) {
    const match = /^refs\/pull\/(\d+)\/head ([0-9a-f]+)$/.exec(line);
    if (match) heads.set(Number(match[1]), match[2]!);
  }
  return heads;
};

export const readKeep = (text: string) =>
  new Set(text.split('\n').map((line) => line.replace(/#.*/, '').trim()).filter(Boolean));

/** The most branches one confirmed batch may delete (docs/DEVELOPMENT.md, Branch hygiene). */
export const BATCH_LIMIT = 25;
const CANDIDATE_LINE = /^[^\s|]+\|[0-9a-f]{40,64}\|\d+\|[0-9a-f]{40,64}$/;

/** The lines of a --confirm batch, or why it can't be one. */
export const readBatch = (text: string): { lines: string[] } | { error: string } => {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const bad = lines.find((line) => !CANDIDATE_LINE.test(line));
  if (bad !== undefined) return { error: `not a candidate line (branch|tip|merged-PR#|merged-head): ${bad}` };
  if (lines.length === 0) return { error: 'no candidate lines' };
  if (lines.length > BATCH_LIMIT) return { error: `${lines.length} lines; a batch is at most ${BATCH_LIMIT}` };
  return { lines };
};

const arg = (args: readonly string[], name: string) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

export const main = (args: readonly string[]) => {
  const gitDir = arg(args, 'git-dir');
  const pullsFile = arg(args, 'pulls');
  const confirmFile = arg(args, 'confirm');
  const evidence = args.includes('--evidence');
  if (!gitDir || !pullsFile || confirmFile === '' || (evidence && confirmFile === undefined)) {
    console.error('usage: branch-inventory.ts --git-dir=<bare clone> --pulls=<pulls.json> [--keep=<file>] [--protected=a,b] [--now=<ISO>] [--confirm=<file> [--evidence]]');
    return 2;
  }
  let batch: string[] | undefined;
  if (confirmFile !== undefined) {
    let text: string;
    try { text = readFileSync(confirmFile, 'utf8'); } catch {
      console.error(`--confirm: can't read ${confirmFile}`);
      return 2;
    }
    const read = readBatch(text);
    if ('error' in read) {
      console.error(`--confirm: ${read.error}`);
      return 2;
    }
    batch = read.lines;
  }
  const run: GitRun = (gitArgs) => execFileSync('git', ['--git-dir', gitDir, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const pulls = (JSON.parse(readFileSync(pullsFile, 'utf8')) as unknown[]).flat() as Pull[];
  const repo = pulls[0]?.base.repo?.full_name ?? '';
  const now = new Date(arg(args, 'now') ?? Date.now());
  const keepFile = arg(args, 'keep');
  const protectedBranches = new Set((arg(args, 'protected') ?? 'main').split(',').filter(Boolean));
  const pullHeads = readPullHeads(run);
  const classified = classify(readBranches(run), pulls, {
    repo,
    defaultBranch: 'main',
    protectedBranches,
    keep: keepFile ? readKeep(readFileSync(keepFile, 'utf8')) : new Set(),
    now,
    isAncestor: ancestry(run),
    pullHead: (pr) => pullHeads.get(pr),
  });
  const takenAt = now.toISOString().replace(/\.\d+Z$/, 'Z');
  if (!batch) {
    console.log(report(classified, pulls.length, takenAt));
    return 0;
  }
  const { confirmed, skipped } = confirm(batch, classified);
  console.log([`# Confirmed at ${takenAt}: ${confirmed.length}`, ...confirmed, '', `# Skipped: ${skipped.length}`, ...skipped].join('\n'));
  if (evidence) {
    const detail = `batch of ${batch.length}: ${confirmed.length} confirmed for deletion, ${skipped.length} skipped`;
    mkdirSync('test-results/quality-evidence', { recursive: true });
    writeFileSync('test-results/quality-evidence/branch-hygiene.json', `${JSON.stringify({ status: 'pass', date: takenAt.slice(0, 10), detail })}\n`);
  }
  return 0;
};

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
