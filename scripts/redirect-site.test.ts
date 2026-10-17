import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SETS } from '../src/content/sets/index.ts';
import { PAGE_TITLES, pageHash, setLinkHash, type Page } from '../src/game/route.ts';
import { redirectPage } from './redirect-site.ts';

const NEW = 'https://brainrottcg.pages.dev/';
const PROOF = 'v4.' + 'A'.repeat(80);
const PROFILE = 'a'.repeat(120);

/** Opens the old address at `url` and runs the page's script, with `save` in its storage. */
const visit = (url: string, save: Record<string, string> = {}) => {
  const script = /<script>([\s\S]*)<\/script>/.exec(redirectPage(NEW))![1];
  const { pathname, hash } = new URL(url);
  const keys = Object.keys(save);
  const elements: Record<string, { hidden?: boolean; textContent?: string; onclick?: () => void }> = {};
  let target: string | null = null;
  runInNewContext(script, {
    URL,
    location: { pathname, hash, replace: (to: string) => { target = to; } },
    document: { getElementById: (id: string) => (elements[id] ??= {}) },
    localStorage: { length: keys.length, key: (i: number) => keys[i] ?? null, getItem: (key: string) => save[key] ?? null, setItem: () => {} },
    window: { opener: null, open: () => null, addEventListener: () => {} },
  });
  return { get target() { return target; }, elements };
};

describe('redirectPage', () => {
  const pages = (Object.keys(PAGE_TITLES) as Page[]).map(pageHash);

  it.each([...pages, `#/pull/${PROOF}`, '#/pull/cut-off', `#/profile/${PROFILE}`, ...SETS.map((set) => setLinkHash(set.id)), '#/set/right-now/'])(
    'carries %s to the same place at the new address',
    (hash) => {
      expect(visit(`https://evanlin23.github.io/BrainrotTCG/${hash}`).target).toBe(NEW + hash);
    },
  );

  it('keeps the path below the old base, with its route', () => {
    expect(visit(`https://evanlin23.github.io/BrainrotTCG/p/0123abcd.html#/pull/${PROOF}`).target).toBe(`${NEW}p/0123abcd.html#/pull/${PROOF}`);
    expect(visit('https://evanlin23.github.io/BrainrotTCG/s/genesis/').target).toBe(`${NEW}s/genesis/`);
    expect(visit('https://evanlin23.github.io/BrainrotTCG/index.html#/cards').target).toBe(`${NEW}#/cards`);
  });

  it.each(['', '#', '#/open', '#/receive', '#/send', '#/cards/x', '#/settingsx', '#/set/', '#/set/Genesis', '#/set/a/b', '#/sets/genesis', '#javascript:alert(1)'])(
    "drops %s, which isn't one of the app's routes",
    (hash) => {
      expect(visit(`https://evanlin23.github.io/BrainrotTCG/${hash}`).target).toBe(NEW);
    },
  );

  it('offers to bring a save first, and going without it still keeps the route', () => {
    const page = visit('https://evanlin23.github.io/BrainrotTCG/#/set/genesis', { 'brainrot-save-v1': '{}' });
    expect(page.target).toBeNull();
    expect(page.elements.choice.hidden).toBe(false);
    page.elements.skip.onclick!();
    expect(page.target).toBe(`${NEW}#/set/genesis`);
  });
});
