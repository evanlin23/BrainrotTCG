import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ancestry, candidateLine, classify, confirm, readBranches, readKeep, type Branch, type Options, type Pull } from './branch-inventory.ts';

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

// Ancestry in the fixture: 1 <- 2 <- 3 is one line of commits, and 1 is in main.
const LINE = [sha(1), sha(2), sha(3)];
const options = (extra: Partial<Options> = {}): Options => ({
  repo: REPO,
  defaultBranch: 'main',
  protectedBranches: new Set(['main']),
  keep: new Set(),
  now: NOW,
  isAncestor: (a, b) => (b === 'main' ? a === sha(1) : LINE.includes(a) && LINE.includes(b) && LINE.indexOf(a) <= LINE.indexOf(b)),
  ...extra,
});

const one = (b: Branch, pulls: Pull[], extra: Partial<Options> = {}) => classify([b], pulls, options(extra))[0];

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
    expect(classify([branch('feature/a', sha(2)), branch('feature/b', sha(2)), branch('feature/base', sha(2))], pulls, options()).map((b) => b.category))
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
  const before = classify([branch('claude/a', sha(2)), branch('claude/b', sha(2)), branch('claude/c', sha(2))], pulls, options());
  const lines = before.map(candidateLine);

  it('confirms only candidates whose tip and evidence are unchanged', () => {
    const after = classify([branch('claude/a', sha(2)), branch('claude/b', sha(3)), branch('claude/c', sha(2))], [...pulls, pull(20, 'claude/c', sha(2), { state: 'open' })], options());
    const { confirmed, skipped } = confirm([...lines, `claude/gone|${sha(2)}|1|${sha(2)}`], after);
    expect(confirmed).toEqual([lines[0]]);
    expect(skipped).toEqual([`${lines[1]} (now merged-newer)`, `${lines[2]} (now open-pr)`, `claude/gone|${sha(2)}|1|${sha(2)} (branch is gone)`]);
  });

  it('skips a line whose evidence changed while the branch stays a candidate', () => {
    const after = classify([branch('claude/a', sha(2))], [merged(7, 'claude/a', sha(3))], options());
    expect(confirm([lines[0]], after).skipped).toEqual([`${lines[0]} (tip or evidence changed: claude/a|${sha(2)}|7|${sha(3)})`]);
  });
});

it('reads a keep list with comments', () => {
  expect([...readKeep('claude/a # active\n\n# a hold\nclaude/b\n')]).toEqual(['claude/a', 'claude/b']);
});

describe('on a disposable local repository', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
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
});
