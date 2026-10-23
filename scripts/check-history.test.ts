import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonical, checkHistory, compareCorpus, exactNumber, parseCorpus, resolveBase } from './check-history.ts';

/**
 * Synthetic base/candidate pairs in scripts/fixtures/history stand in for the vector files and the
 * set lock; the real spec/vectors*.json and src/content/sets.lock.json are never read here.
 */
const FIXTURES = fileURLToPath(new URL('./fixtures/history/', import.meta.url));
const text = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));
const vectors = (candidate: string) => compareCorpus('v.json', fixture('vectors-base.json'), fixture(candidate));
const lock = (candidate: string) => compareCorpus('lock.json', fixture('lock-base.json'), fixture(candidate));

describe('compareCorpus', () => {
  it('passes a candidate with the same values in other formatting and key order', () => {
    expect(text('vectors-formatted.json')).not.toBe(text('vectors-base.json'));
    expect(vectors('vectors-formatted.json')).toEqual([]);
  });

  it('passes new cases inserted or appended and a new version list', () => {
    expect(vectors('vectors-additive.json')).toEqual([]);
  });

  it('fails a removed case', () => {
    expect(vectors('vectors-removed.json')).toEqual([expect.stringMatching(/^v\.json: packs\[1\] was removed or changed/)]);
  });

  it('fails an edited old case', () => {
    expect(vectors('vectors-edited.json')).toEqual([expect.stringMatching(/^v\.json: packs\[1\] was removed or changed/)]);
  });

  it('fails an old case replaced by a new one, though the count is the same', () => {
    expect(vectors('vectors-replaced.json')).toEqual([expect.stringMatching(/^v\.json: packs\[1\] was removed or changed/)]);
  });

  it('fails reordered old cases', () => {
    expect(vectors('vectors-reordered.json')).toEqual([expect.stringMatching(/^v\.json: packs\[1\] moved before/)]);
  });

  it('fails an old case whose own lists were reordered (the cards of a pack)', () => {
    const candidate = fixture('vectors-base.json') as { packs: { cards: unknown[] }[] };
    candidate.packs[0].cards.reverse();
    expect(compareCorpus('v.json', fixture('vectors-base.json'), candidate)).toEqual([
      expect.stringMatching(/^v\.json: packs\[0\] was removed or changed/),
    ]);
  });

  it('calls one deleted copy of a duplicated entry removed, not moved', () => {
    expect(compareCorpus('v.json', { invalid: ['a', 'b', 'a'] }, { invalid: ['a', 'b'] })).toEqual([
      expect.stringMatching(/^v\.json: invalid\[2\] was removed or changed/),
    ]);
    expect(compareCorpus('v.json', { invalid: ['a', 'b', 'a'] }, { invalid: ['a', 'a', 'b'] })).toEqual([
      expect.stringMatching(/^v\.json: invalid\[2\] moved before/),
    ]);
  });

  it('fails a changed field outside the lists', () => {
    expect(vectors('vectors-field-changed.json')).toEqual([expect.stringMatching(/^v\.json: testKey changed from/)]);
  });

  it('fails a removed list', () => {
    expect(vectors('vectors-list-removed.json')).toEqual(['v.json: invalid was removed']);
  });

  it('fails a list turned into another value', () => {
    expect(compareCorpus('v.json', { packs: [] }, { packs: {} })).toEqual(['v.json: packs is no longer a list']);
  });

  it('passes a lock with a new set version, other key order and indentation', () => {
    expect(lock('lock-added.json')).toEqual([]);
  });

  it('fails an edited release hash', () => {
    expect(lock('lock-edited.json')).toEqual([expect.stringMatching(/^lock\.json: alpha@2 changed from "b{64}" to "d{64}"$/)]);
  });

  it('fails a removed release', () => {
    expect(lock('lock-removed.json')).toEqual(['lock.json: beta@1 was removed']);
  });

  it('fails a candidate that is not an object', () => {
    expect(compareCorpus('v.json', {}, [])).toEqual(['v.json: is no longer a JSON object']);
  });

  it('keeps list order but not key order in the canonical form', () => {
    expect(canonical({ b: 1, a: [1, 2] })).toBe(canonical({ a: [1, 2], b: 1 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});

describe('parseCorpus', () => {
  it('refuses numbers that only compare equal as doubles', () => {
    expect(parseCorpus('{"n": 9007199254740991}', 'v.json')).toEqual({ n: 9007199254740991 });
    for (const n of ['9007199254740991.0', '9007199254740993', '9007199254740992', '1e3', '-0', '0.5']) {
      expect(() => parseCorpus(`{"n": [${n}]}`, 'v.json')).toThrow(/^v\.json is refused: the number .* is not a safe integer/);
    }
  });

  it('says it needs Node 22 when the reviver gets no source text (Node 20 passes no context)', () => {
    expect(() => exactNumber('n', 1)).toThrow('check-history needs Node 22 (JSON.parse reviver context)');
    expect(() => exactNumber('n', 1, {})).toThrow('check-history needs Node 22 (JSON.parse reviver context)');
    expect(exactNumber('s', 'text')).toBe('text');
    expect(exactNumber('n', 1, { source: '1' })).toBe(1);
  });
});

describe('checkHistory', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const FILES = ['spec/v.json', 'lock.json'];
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const put = (file: string, from: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text(from));
  };
  /** A repository whose only commit holds the base fixtures; returns that commit. */
  const repo = () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'check-history-'));
    git('init', '-q');
    put('spec/v.json', 'vectors-base.json');
    put('lock.json', 'lock-base.json');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    return git('rev-parse', 'HEAD');
  };

  // vite.config.ts test.env: without it a detached auto-maintenance child of `git commit` can still be
  // writing in .git when afterEach deletes the repository (ENOTEMPTY).
  it('runs git in its scratch repositories with auto maintenance off', () => {
    repo();
    expect(git('config', '--get', 'maintenance.auto')).toBe('false');
    expect(git('config', '--get', 'gc.auto')).toBe('0');
  });

  it('passes a working tree that only added to the base', () => {
    const base = repo();
    put('spec/v.json', 'vectors-additive.json');
    put('lock.json', 'lock-added.json');
    expect(checkHistory(dir, base, FILES)).toEqual([]);
  });

  it('reads the base from git, not the working tree', () => {
    const base = repo();
    put('spec/v.json', 'vectors-edited.json');
    put('lock.json', 'lock-edited.json');
    expect(checkHistory(dir, base, FILES)).toEqual([
      expect.stringMatching(/^spec\/v\.json: packs\[1\] was removed or changed/),
      expect.stringMatching(/^lock\.json: alpha@2 changed/),
    ]);
  });

  it('fails clearly when the base is not in the checkout', () => {
    repo();
    expect(() => checkHistory(dir, 'f'.repeat(40), FILES)).toThrow(/is not available in this checkout\. Fetch it first/);
    expect(() => checkHistory(dir, 'no-such-branch', FILES)).toThrow(/is not available/);
  });

  it('refuses a base that git would read as an option', () => {
    repo();
    expect(() => resolveBase(dir, '--all')).toThrow(/Invalid base revision/);
    expect(() => resolveBase(dir, '')).toThrow(/Invalid base revision/);
  });

  it('fails a working tree file that is not JSON', () => {
    const base = repo();
    writeFileSync(path.join(dir, 'lock.json'), '{"alpha@1": ');
    expect(() => checkHistory(dir, base, FILES)).toThrow(/^lock\.json is not valid JSON/);
  });

  it('fails a non-canonical or unsafe number on either side', () => {
    const base = repo();
    writeFileSync(path.join(dir, 'spec/v.json'), '{"version": 9007199254740991.0}');
    expect(() => checkHistory(dir, base, FILES)).toThrow(/^spec\/v\.json is refused: the number 9007199254740991\.0/);
    writeFileSync(path.join(dir, 'lock.json'), '{"big": 9007199254740993}');
    git('add', '.');
    git('commit', '-q', '-m', 'big');
    const big = git('rev-parse', 'HEAD');
    writeFileSync(path.join(dir, 'lock.json'), '{"big": 9007199254740992}');
    expect(() => checkHistory(dir, big, ['lock.json'])).toThrow(/^lock\.json at [0-9a-f]+ is refused: the number 9007199254740993/);
  });

  it('has no retirement path: a file in the working tree naming the removed entry changes nothing', () => {
    const base = repo();
    const removed = (fixture('vectors-base.json') as { packs: unknown[] }).packs[1];
    put('spec/v.json', 'vectors-removed.json');
    writeFileSync(path.join(dir, 'spec/retired-vectors.json'), JSON.stringify({ retired: [{ file: 'spec/v.json', list: 'packs', entry: removed }] }));
    expect(checkHistory(dir, base, FILES)).toEqual([expect.stringMatching(/^spec\/v\.json: packs\[1\] was removed or changed/)]);
  });

  it('fails when the base lacks a file or the working tree deleted one', () => {
    const base = repo();
    rmSync(path.join(dir, 'lock.json'));
    expect(checkHistory(dir, base, [...FILES, 'other.json'])).toEqual([
      expect.stringMatching(/^lock\.json: was deleted/),
      expect.stringMatching(/^other\.json: missing at base/),
    ]);
  });
});
