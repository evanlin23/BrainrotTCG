import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_SET_VERSIONS } from '../src/content/sets/index.ts';
import { checkNoArtBriefs } from './check-site.ts';
import { artBriefStripper, SET_FILE, stripArtBriefs } from './strip-art-briefs.ts';

const SETS_DIR = fileURLToPath(new URL('../src/content/sets/', import.meta.url));
const setFiles = readdirSync(SETS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => readdirSync(path.join(SETS_DIR, entry.name)).filter((name) => /^set(\.v\d+)?\.json$/.test(name)).map((name) => path.join(SETS_DIR, entry.name, name)));

describe('card art briefs in the browser bundle (#1365)', () => {
  it('drops each card\'s art and keeps every other key, in order', () => {
    const input = { id: 'x', name: 'X', version: 2, cards: [{ id: 'a', name: 'A', art: 'a brief', rarity: 'common' }, { id: 'b', name: 'B', rarity: 'rare' }] };
    const out = JSON.parse(stripArtBriefs(JSON.stringify(input)));
    expect(out).toEqual({ ...input, cards: [{ id: 'a', name: 'A', rarity: 'common' }, { id: 'b', name: 'B', rarity: 'rare' }] });
    expect(Object.keys(out)).toEqual(Object.keys(input));
    expect(Object.keys(out.cards[0])).toEqual(['id', 'name', 'rarity']);
  });

  it('refuses a set file without cards instead of passing it through', () => {
    expect(() => stripArtBriefs('{"id":"x"}')).toThrow(/no cards array/);
  });

  it.each(setFiles.map((file) => [path.relative(SETS_DIR, file), file]))('%s keeps all its data except art', (_name, file) => {
    const original = JSON.parse(readFileSync(file, 'utf8')) as { cards: Record<string, unknown>[] };
    const out = JSON.parse(stripArtBriefs(readFileSync(file, 'utf8'))) as typeof original;
    expect(out.cards.some((card) => 'art' in card)).toBe(false);
    expect(out).toEqual({ ...original, cards: original.cards.map(({ art: _art, ...card }) => card) });
  });

  it('finds the set files the registry imports, on any platform', () => {
    expect(setFiles.length).toBe(ALL_SET_VERSIONS.length);
    for (const file of setFiles) {
      expect(SET_FILE.test(file)).toBe(true);
      expect(SET_FILE.test(file.replaceAll('/', '\\'))).toBe(true);
    }
    expect(SET_FILE.test('/repo/src/content/sets/index.ts')).toBe(false);
    expect(SET_FILE.test('/repo/package.json')).toBe(false);
    expect(SET_FILE.test('/repo/src/content/sets/genesis/cards.json')).toBe(false);
  });

  it('transforms only set files, and only in the production build', () => {
    const plugin = artBriefStripper();
    expect(plugin.apply).toBe('build');
    const transform = plugin.transform as (code: string, id: string) => string | null;
    const json = JSON.stringify({ cards: [{ id: 'a', art: 'brief' }] });
    expect(transform(json, '/repo/src/content/sets/x/set.json?import')).toBe('{"cards":[{"id":"a"}]}');
    expect(transform(json, '/repo/package.json')).toBeNull();
    // Registered in the build's plugins (check:site then fails a build that lost it).
    expect(readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8')).toMatch(/plugins: \[[^\]]*\bartBriefStripper\(\)/);
  });

  it('fails a build whose plugin never matched a set file', () => {
    const plugin = artBriefStripper();
    const buildEnd = plugin.buildEnd as (error?: Error) => void;
    expect(() => buildEnd()).toThrow(/no set file was transformed/);
    expect(() => buildEnd(new Error('other'))).not.toThrow();
  });

  it('check:site flags built code that holds a brief, escaped or not, and passes code without one', () => {
    const brief = ALL_SET_VERSIONS.flatMap((set) => set.cards).find((card) => card.art)!.art!;
    expect(checkNoArtBriefs(new Map([['assets/a-AbCd1234.js', `var s="${brief}"`]]))).toEqual([
      { path: 'assets/a-AbCd1234.js', error: expect.stringMatching(/^Contains a card art brief/) },
    ]);
    const quoted = { id: 's', cards: [{ id: 'c', art: 'a "quoted" brief' }] } as never;
    expect(checkNoArtBriefs(new Map([['assets/b-AbCd1234.js', `var s=${JSON.stringify('a "quoted" brief')}`]]), [quoted])).toHaveLength(1);
    expect(checkNoArtBriefs(new Map([['assets/c-AbCd1234.js', 'var s="nothing here"']]))).toEqual([]);
  });
});
