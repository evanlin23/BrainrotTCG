import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ancestry, candidateLine, classify, confirm, main, readBatch, readBranches, readKeep, readPullHeads, type Branch, type Options, type Pull,
} from './branch-inventory.ts';

const REPO = 'owner/game';
const NOW = new Date('2026-10-23T08:00:00Z');
const OLD = '2026-10-01T00:00:00Z';
const sha = (n: number) => n.toString(16).padStart(40, '0');

const pull = (number: number, ref: string, head: string, extra: Partial<Pull> = {}): Pull => ({
  number,
  state: 'closed',
  merged_at: null,
  head: { ref, sha: head, repo: { full_name: REPO } },
  base: { ref: 'main', repo: { full_name: REPO } },
  ...extra,
});
const merged = (number: number, ref: string, head: string) => pull(number, ref, head, { merged_at: OLD });
const branch = (name: string, tip: string, committedAt = OLD): Branch => ({ name, tip, committedAt });

// Ancestry in the fixture: 1 <- 2 <- 3 is one line of commits, and 1 is in main. Unless a test
// says otherwise, the clone has every PR's refs/pull/<n>/head at that PR's head.
const LINE = [sha(1), sha(2), sha(3)];
const options = (pulls: readonly Pull[], extra: Partial<Options> = {}): Options => ({
  repo: REPO,
  defaultBranch: 'main',
  protectedBranches: new Set(['main']),
  keep: new Set(),
  now: NOW,
  isAncestor: (a, b) => (b === 'main' ? a === sha(1) : LINE.includes(a) && LINE.includes(b) && LINE.indexOf(a) <= LINE.indexOf(b)),
  pullHead: (pr) => pulls.find((p) => p.number === pr)?.head.sha,
  ...extra,
});
const inventory = (branches: Branch[], pulls: Pull[], extra: Partial<Options> = {}) => classify(branches, pulls, options(pulls, extra));

const one = (b: Branch, pulls: Pull[], extra: Partial<Options> = {}) => inventory([b], pulls, extra)[0];

describe('classify (dry run)', () => {
  it('keeps the default and protected branches', () => {
    expect(one(branch('main', sha(1)), []).category).toBe('protected');
    expect(one(branch('release', sha(1)), [], { protectedBranches: new Set(['main', 'release']) }).category).toBe('protected');
  });

  it('keeps the head of an open or draft PR, and a branch an open PR is stacked on', () => {
    const open = pull(10, 'feature/a', sha(2), { state: 'open' });
    const draft = pull(11, 'feature/b', sha(2), { state: 'open', draft: true });
    const stacked = pull(12, 'feature/c', sha(3), { state: 'open', base: { ref: 'feature/base', repo: { full_name: REPO } } });
    // The stacked base was itself merged once: an open PR still needs it.
    const pulls = [open, draft, stacked, merged(9, 'feature/base', sha(2))];
    expect(inventory([branch('feature/a', sha(2)), branch('feature/b', sha(2)), branch('feature/base', sha(2))], pulls).map((b) => b.category))
      .toEqual(['open-pr', 'open-pr', 'open-pr']);
  });

  it('keeps a held or active branch on the keep list even when its PR merged', () => {
    expect(one(branch('claude/active', sha(2)), [merged(5, 'claude/active', sha(2))], { keep: new Set(['claude/active']) }).category).toBe('kept');
  });

  it('keeps dependency bot branches and anything committed in the last day', () => {
    expect(one(branch('dependabot/npm/x', sha(2)), [merged(5, 'dependabot/npm/x', sha(2))]).category).toBe('dependency');
    expect(one(branch('claude/new', sha(2), '2026-10-22T09:00:00Z'), [merged(5, 'claude/new', sha(2))]).category).toBe('recent');
    expect(one(branch('claude/batch-9', sha(2), '2026-10-21T09:00:00Z'), [merged(5, 'claude/batch-9', sha(2))]).category).toBe('recent');
    expect(one(branch('claude/batch-8', sha(2), '2026-10-21T07:00:00Z'), [merged(5, 'claude/batch-8', sha(2))]).category).toBe('candidate');
    expect(one(branch('claude/odd-date', sha(2), 'not a date'), [merged(5, 'claude/odd-date', sha(2))]).category).toBe('recent');
  });

  it('retires a squash-merged branch whose tip is the merged head, though the tip is not in main', () => {
    const result = one(branch('claude/squashed', sha(2)), [merged(7, 'claude/squashed', sha(2))]);
    expect(result).toMatchObject({ category: 'candidate', pr: 7, mergedHead: sha(2) });
    expect(candidateLine(result)).toBe(`claude/squashed|${sha(2)}|7|${sha(2)}`);
  });

  it('retires a branch whose tip is an ancestor of the merged head', () => {
    expect(one(branch('claude/behind', sha(2)), [merged(7, 'claude/behind', sha(3))])).toMatchObject({ category: 'candidate', pr: 7, mergedHead: sha(3) });
  });

  it('keeps a merged branch until the clone has its PR ref at the merged head, the copy a restore needs', () => {
    const pulls = [merged(7, 'claude/unfetched', sha(2))];
    expect(one(branch('claude/unfetched', sha(2)), pulls, { pullHead: () => undefined })).toMatchObject({ category: 'unverified', pr: 7, mergedHead: sha(2) });
    expect(one(branch('claude/unfetched', sha(2)), pulls, { pullHead: () => sha(3) }).category).toBe('unverified');
    // An older merged PR whose ref is there still holds the tip.
    const twice = [merged(7, 'claude/twice', sha(2)), merged(9, 'claude/twice', sha(3))];
    expect(one(branch('claude/twice', sha(2)), twice, { pullHead: (pr) => (pr === 7 ? sha(2) : undefined) }))
      .toMatchObject({ category: 'candidate', pr: 7, mergedHead: sha(2) });
  });

  it('keeps a merged branch that gained commits after its merged head', () => {
    expect(one(branch('claude/more', sha(3)), [merged(7, 'claude/more', sha(2))])).toMatchObject({ category: 'merged-newer', pr: 7 });
    // An unrelated tip (a force-push after merge) is not preserved either.
    expect(one(branch('claude/rewritten', sha(99)), [merged(7, 'claude/rewritten', sha(2))]).category).toBe('merged-newer');
  });

  it('keeps closed-unmerged and no-PR branches, noting a tip already in main', () => {
    expect(one(branch('codex/closed', sha(2)), [pull(8, 'codex/closed', sha(2))])).toMatchObject({ category: 'closed-unmerged', pr: 8 });
    expect(one(branch('codex/none', sha(1)), [])).toMatchObject({ category: 'no-pr', note: 'tip is already in main' });
  });

  it('ignores a PR from a fork that reuses the branch name', () => {
    const fork = merged(6, 'feature/x', sha(2));
    fork.head.repo = { full_name: 'someone/game' };
    expect(one(branch('feature/x', sha(2)), [fork]).category).toBe('no-pr');
  });
});

describe('confirm', () => {
  const pulls = [merged(7, 'claude/a', sha(2)), merged(8, 'claude/b', sha(2)), merged(9, 'claude/c', sha(2))];
  const before = inventory([branch('claude/a', sha(2)), branch('claude/b', sha(2)), branch('claude/c', sha(2))], pulls);
  const lines = before.map(candidateLine);

  it('confirms only candidates whose tip and evidence are unchanged', () => {
    const after = inventory([branch('claude/a', sha(2)), branch('claude/b', sha(3)), branch('claude/c', sha(2))], [...pulls, pull(20, 'claude/c', sha(2), { state: 'open' })]);
    const { confirmed, skipped } = confirm([...lines, `claude/gone|${sha(2)}|1|${sha(2)}`], after);
    expect(confirmed).toEqual([lines[0]]);
    expect(skipped).toEqual([`${lines[1]} (now merged-newer)`, `${lines[2]} (now open-pr)`, `claude/gone|${sha(2)}|1|${sha(2)} (branch is gone)`]);
  });

  it('skips a line whose evidence changed while the branch stays a candidate', () => {
    const after = inventory([branch('claude/a', sha(2))], [merged(7, 'claude/a', sha(3))]);
    expect(confirm([lines[0]], after).skipped).toEqual([`${lines[0]} (tip or evidence changed: claude/a|${sha(2)}|7|${sha(3)})`]);
  });
});

describe('a confirm batch', () => {
  const line = (n: number) => `claude/b${n}|${sha(2)}|${n}|${sha(2)}`;

  it('takes up to 25 candidate lines, blank lines aside', () => {
    expect(readBatch(`${line(1)}\n\n  ${line(2)}  \n`)).toEqual({ lines: [line(1), line(2)] });
    expect(readBatch(Array.from({ length: 25 }, (_, i) => line(i)).join('\n'))).toMatchObject({ lines: expect.any(Array) });
  });

  it('refuses an empty, malformed or oversized batch', () => {
    expect(readBatch('\n \n')).toEqual({ error: 'no candidate lines' });
    expect(readBatch(`${line(1)}\n# Confirmed at 2026-10-23T08:00:00Z: 1`)).toMatchObject({ error: expect.stringContaining('not a candidate line') });
    expect(readBatch(`claude/a|${sha(2)}|7`)).toMatchObject({ error: expect.stringContaining('not a candidate line') });
    expect(readBatch(Array.from({ length: 26 }, (_, i) => line(i)).join('\n'))).toEqual({ error: '26 lines; a batch is at most 25' });
  });

  it('exits 2 before reading anything when --confirm or --evidence is misused', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(path.join(os.tmpdir(), 'branch-inventory-args-'));
    try {
      const bad = path.join(dir, 'bad.txt');
      writeFileSync(bad, 'claude/a only a name\n');
      const base = ['--git-dir=/nonexistent/inv.git', '--pulls=/nonexistent/pulls.json'];
      expect(main([...base, '--confirm='])).toBe(2);
      expect(main([...base, '--evidence'])).toBe(2);
      expect(main([...base, `--confirm=${bad}`])).toBe(2);
      expect(main([...base, `--confirm=${path.join(dir, 'missing.txt')}`])).toBe(2);
      expect(log).not.toHaveBeenCalled();
      expect(error.mock.calls.map(([message]) => String(message).split(':')[0])).toEqual(['usage', 'usage', '--confirm', '--confirm']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});

it('reads a keep list with comments', () => {
  expect([...readKeep('claude/a # active\n\n# a hold\nclaude/b\n')]).toEqual(['claude/a', 'claude/b']);
});

describe('on a disposable local repository', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  const isolation = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', ...isolation };
  const gitIn = (cwd: string) => (args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  it('reads tips and ancestry, and restores a retired branch from its PR ref', () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'branch-inventory-'));
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    gitIn(root)(['init', '-q', '--bare', '-b', 'main', origin]);
    gitIn(root)(['clone', '-q', origin, work]);
    const w = gitIn(work);
    w(['commit', '-q', '--allow-empty', '-m', 'base']);
    w(['push', '-q', 'origin', 'HEAD:main']);
    w(['checkout', '-q', '-b', 'claude/done']);
    w(['commit', '-q', '--allow-empty', '-m', 'one']);
    const behind = w(['rev-parse', 'HEAD']);
    w(['commit', '-q', '--allow-empty', '-m', 'two']);
    const tip = w(['rev-parse', 'HEAD']);
    // GitHub keeps refs/pull/<n>/head for every PR; the fixture plays that part.
    w(['push', '-q', 'origin', 'HEAD:refs/heads/claude/done', 'HEAD:refs/pull/1/head']);

    const o = gitIn(origin);
    expect(readBranches(o).map(({ name, tip: t }) => [name, t])).toEqual([['claude/done', tip], ['main', w(['rev-parse', 'main'])]]);
    expect(ancestry(o)(behind, tip)).toBe(true);
    expect(ancestry(o)(tip, behind)).toBe(false);
    expect(ancestry(o)('0'.repeat(40), tip)).toBe(false);

    // Retire it, then restore it the way docs/DEVELOPMENT.md says: fetch the PR ref, push it back at the recorded tip.
    w(['push', '-q', 'origin', '--delete', 'claude/done']);
    expect(readBranches(o).map((b) => b.name)).toEqual(['main']);
    const fresh = path.join(root, 'fresh');
    gitIn(root)(['clone', '-q', origin, fresh]);
    const f = gitIn(fresh);
    f(['fetch', '-q', 'origin', 'refs/pull/1/head']);
    expect(f(['rev-parse', 'FETCH_HEAD'])).toBe(tip);
    f(['push', '-q', 'origin', `${tip}:refs/heads/claude/done`]);
    expect(readBranches(o).find((b) => b.name === 'claude/done')?.tip).toBe(tip);
  });

  it('inventories a clone, then confirms a batch only after a refresh that sees the moved tip', () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'branch-inventory-'));
    const home = process.cwd();
    for (const [name, value] of Object.entries(isolation)) vi.stubEnv(name, value);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const origin = path.join(root, 'origin.git');
      const work = path.join(root, 'work');
      gitIn(root)(['init', '-q', '--bare', '-b', 'main', origin]);
      gitIn(root)(['clone', '-q', origin, work]);
      // Old commit dates, so nothing is `recent` against --now.
      const w = (args: string[]) => execFileSync('git', args, {
        cwd: work, env: { ...env, GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      w(['commit', '-q', '--allow-empty', '-m', 'base']);
      w(['push', '-q', 'origin', 'HEAD:main']);
      w(['checkout', '-q', '-b', 'claude/done']);
      w(['commit', '-q', '--allow-empty', '-m', 'done one']);
      const behind = w(['rev-parse', 'HEAD']);
      w(['commit', '-q', '--allow-empty', '-m', 'done two']);
      const head = w(['rev-parse', 'HEAD']);
      w(['push', '-q', 'origin', 'HEAD:refs/heads/claude/done', 'HEAD:refs/pull/1/head']);
      // Merged too, but its PR ref never reached the clone.
      w(['checkout', '-q', '-b', 'claude/unfetched', 'main']);
      w(['commit', '-q', '--allow-empty', '-m', 'unfetched']);
      const unfetched = w(['rev-parse', 'HEAD']);
      w(['push', '-q', 'origin', 'HEAD:refs/heads/claude/unfetched']);

      const inv = path.join(root, 'inv.git');
      gitIn(root)(['clone', '-q', '--bare', origin, inv]);
      // The refresh docs/DEVELOPMENT.md gives (Branch hygiene).
      const refresh = () => gitIn(root)(['--git-dir', inv, 'fetch', '-q', '--prune', 'origin', '+refs/heads/*:refs/heads/*', '+refs/pull/*/head:refs/pull/*/head']);
      refresh();
      expect(readPullHeads(gitIn(inv))).toEqual(new Map([[1, head]]));

      const pullsFile = path.join(root, 'pulls.json');
      const pulls = [merged(1, 'claude/done', head), merged(2, 'claude/unfetched', unfetched)];
      writeFileSync(pullsFile, JSON.stringify([pulls]));
      const args = [`--git-dir=${inv}`, `--pulls=${pullsFile}`, `--now=${NOW.toISOString()}`];
      const output = () => log.mock.calls.map(([text]) => String(text)).join('\n');
      // --evidence writes under the working directory, as from the checkout.
      process.chdir(root);
      const evidence = path.join(root, 'test-results/quality-evidence/branch-hygiene.json');

      expect(main(args)).toBe(0);
      const line = `claude/done|${head}|1|${head}`;
      expect(output()).toContain(`\n${line}\n`);
      expect(output()).toContain(`## unverified (1)\n\n- claude/unfetched ${unfetched.slice(0, 7)} 2026-10-01 #2`);
      expect(existsSync(evidence)).toBe(false);

      const batch = path.join(root, 'batch.txt');
      writeFileSync(batch, `${line}\n`);
      log.mockClear();
      expect(main([...args, `--confirm=${batch}`, '--evidence'])).toBe(0);
      expect(output()).toContain(`: 1\n${line}\n`);
      expect(JSON.parse(readFileSync(evidence, 'utf8'))).toEqual({ status: 'pass', date: '2026-10-23', detail: 'batch of 1: 1 confirmed for deletion, 0 skipped' });

      // Someone moves the branch back a commit. It is still behind the merged head, so a candidate,
      // but not the tip the batch recorded.
      w(['push', '-q', '--force', 'origin', `${behind}:refs/heads/claude/done`]);
      // A plain fetch into a bare clone updates no branch: the tip stays stale.
      gitIn(root)(['--git-dir', inv, 'fetch', '-q', 'origin']);
      expect(readBranches(gitIn(inv)).find((b) => b.name === 'claude/done')?.tip).toBe(head);
      refresh();
      log.mockClear();
      expect(main([...args, `--confirm=${batch}`, '--evidence'])).toBe(0);
      expect(output()).toContain(`: 0\n\n# Skipped: 1\n${line} (tip or evidence changed: claude/done|${behind}|1|${head})`);
      expect(JSON.parse(readFileSync(evidence, 'utf8')).detail).toBe('batch of 1: 0 confirmed for deletion, 1 skipped');
    } finally {
      process.chdir(home);
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});
