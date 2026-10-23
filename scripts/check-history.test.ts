import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonical, checkHistory, compareCorpus, resolveBase } from './check-history.ts';

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

  it('fails when the base lacks a file or the working tree deleted one', () => {
    const base = repo();
    rmSync(path.join(dir, 'lock.json'));
    expect(checkHistory(dir, base, [...FILES, 'other.json'])).toEqual([
      expect.stringMatching(/^lock\.json: was deleted/),
      expect.stringMatching(/^other\.json: missing at base/),
    ]);
  });
});
