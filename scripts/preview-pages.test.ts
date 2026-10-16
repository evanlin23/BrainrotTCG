import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { SETS } from '../src/content/sets/index.ts';
import { RARITIES_RAREST_FIRST, type SetDefinition } from '../src/engine/index.ts';
import { cardPreviewPath, previewPath } from '../src/game/previewLinks.ts';
import { generatePreviews, optionsFromEnv, page, setStubs } from './preview-pages.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INDEX_HTML = readFileSync(`${ROOT}index.html`, 'utf8');

/** The link-preview tags a page has, by property or name. */
const tags = (html: string): Map<string, string> =>
  new Map([...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[^"]+)" content="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const redirectTarget = (html: string) => JSON.parse(/location\.replace\(("[^"]*")/.exec(html)![1]) as string;

// The two hosts (docs/HOSTING.md), and the old GitHub Pages address after a move, whose pages
// forward through its redirect page and show pictures from the new address.
const HOSTS = [
  { name: 'GitHub Pages', base: '/BrainrotTCG/', site: 'https://evanlin23.github.io/BrainrotTCG/' },
  { name: 'Cloudflare Pages', base: '/', site: 'https://brainrottcg.pages.dev/' },
  { name: 'the old address after a move', base: '/BrainrotTCG/', site: 'https://brainrottcg.pages.dev/' },
];

const draft = (set: SetDefinition): SetDefinition => ({ ...set, id: `${set.id}-draft`, draft: true });

describe('optionsFromEnv', () => {
  it('defaults to the GitHub Pages address, like vite.config.ts', () => {
    expect(optionsFromEnv({})).toEqual({ outDir: `${ROOT}dist/`, pagesOnly: false, base: '/BrainrotTCG/', site: 'https://evanlin23.github.io/BrainrotTCG/' });
  });

  it('follows the deploy workflow on Cloudflare and for the old address', () => {
    expect(optionsFromEnv({ BASE_PATH: '/', SITE_URL: 'https://brainrottcg.pages.dev/' })).toMatchObject({ base: '/', site: 'https://brainrottcg.pages.dev/' });
    expect(optionsFromEnv({ OUT_DIR: 'pages', PAGES_ONLY: '1', BASE_PATH: '/BrainrotTCG/', SITE_URL: 'https://brainrottcg.pages.dev/' })).toEqual({
      outDir: 'pages/',
      pagesOnly: true,
      base: '/BrainrotTCG/',
      site: 'https://brainrottcg.pages.dev/',
    });
    expect(optionsFromEnv({ OUT_DIR: 'pages/' }).outDir).toBe('pages/');
  });

  it('names SITE_URL ending in one /, whether it was set with one or not', () => {
    for (const SITE_URL of ['https://brainrottcg.pages.dev', 'https://brainrottcg.pages.dev/']) {
      expect(optionsFromEnv({ BASE_PATH: '/', SITE_URL }).site).toBe('https://brainrottcg.pages.dev/');
    }
  });
});

describe('setStubs', () => {
  it('has a page for each released set, from the set registry', () => {
    const stubs = setStubs();
    expect(stubs.map((s) => s.setId)).toEqual(SETS.filter((s) => !s.draft).map((s) => s.id));
    for (const stub of stubs) {
      expect(stub.path).toBe(`s/${stub.setId}/index.html`);
      expect(stub.url).toBe(`s/${stub.setId}/`);
      expect(stub.imagePath).toBe(`s/${stub.setId}/preview.jpg`);
    }
  });

  it('leaves draft sets out', () => {
    const withDraft = [...SETS, draft(SETS[SETS.length - 1])];
    expect(setStubs(withDraft).map((s) => s.setId)).toEqual(setStubs(SETS).map((s) => s.setId));
    expect(setStubs([draft(SETS[0])])).toEqual([]);
  });

  it("shows up to five of the set's rarest cards and describes the set", () => {
    for (const stub of setStubs()) {
      const set = SETS.find((s) => s.id === stub.setId)!;
      const rank = (id: string) => RARITIES_RAREST_FIRST.indexOf(set.cards.find((c) => c.id === id)!.rarity);
      expect(stub.cardIds.length).toBe(Math.min(5, set.cards.length));
      expect(new Set(stub.cardIds).size).toBe(stub.cardIds.length);
      expect(stub.cardIds.map(rank)).toEqual(stub.cardIds.map(rank).sort((a, b) => a - b));
      const shown = Math.max(...stub.cardIds.map(rank));
      expect(set.cards.filter((c) => !stub.cardIds.includes(c.id)).every((c) => RARITIES_RAREST_FIRST.indexOf(c.rarity) >= shown)).toBe(true);
      expect(stub.title).toBe(set.name);
      expect(stub.description).toContain(set.tagline ?? set.name);
      expect(stub.description).toContain(`${set.cards.length} cards`);
    }
  });
});

describe('page', () => {
  it("has index.html's link-preview tags", () => {
    const html = page({ title: 'A Set', description: 'Its cards', image: 'https://example.test/s/a/preview.jpg', url: 'https://example.test/s/a/' }, '/');
    expect([...tags(html).keys()].sort()).toEqual([...tags(INDEX_HTML).keys()].sort());
    expect(tags(html).get('og:url')).toBe('https://example.test/s/a/');
    expect(tags(html).get('twitter:image')).toBe(tags(html).get('og:image'));
  });

  it("gives a pull page no og:url, so a link keeps the pull in its '#'", () => {
    expect(tags(page({ title: 't', description: 'd', image: 'https://example.test/i.jpg' }, '/')).has('og:url')).toBe(false);
  });

  it('escapes what it shows', () => {
    const html = page({ title: 'Vine & "Dank" <3', description: 'a & b', image: 'https://example.test/i.jpg' }, '/');
    expect(html).toContain('<title>Vine &amp; &quot;Dank&quot; &lt;3 · Brainrot TCG</title>');
    expect(tags(html).get('og:title')).toBe('Vine &amp; &quot;Dank&quot; &lt;3');
  });

  it.each(HOSTS)("forwards to the app's path on $name", ({ base }) => {
    const html = page({ title: 't', description: 'd', image: 'https://example.test/i.jpg' }, base);
    expect(redirectTarget(html)).toBe(base);
    expect(html).toContain(`<a href="${base}">Open Brainrot TCG</a>`);
  });
});

describe('generatePreviews (pages only)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it.each(HOSTS)('writes pages where $name serves them, with pictures from the site', async ({ base, site }) => {
    const outDir = `${mkdtempSync(path.join(os.tmpdir(), 'preview-pages-'))}/`;
    dirs.push(outDir);
    const { pages, images } = await generatePreviews({ outDir, pagesOnly: true, base, site });
    expect(images).toBe(0);

    const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(outDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort();
    expect(files).toEqual([...pages.keys()].sort());
    for (const file of files) expect(file).toMatch(/^(p\/[0-9a-f]{8}\.html|s\/[a-z0-9-]+\/index\.html)$/);

    // The pages the app links to (src/game/pulls.ts: BASE_URL + the page + '#/pull/...').
    const set = SETS[SETS.length - 1];
    const [a, b] = set.cards;
    for (const pagePath of [previewPath({ setId: set.id, cardIds: [a.id, b.id], hand: 'FULL_HOUSE' }), cardPreviewPath(set.id, a.id)]) {
      expect(files).toContain(pagePath);
    }

    for (const file of files) {
      const html = readFileSync(`${outDir}${file}`, 'utf8');
      const meta = tags(html);
      expect(redirectTarget(html)).toBe(base);
      expect(meta.get('twitter:image')).toBe(meta.get('og:image'));
      const image = meta.get('og:image')!;
      expect(image.startsWith(site)).toBe(true);
      const relative = image.slice(site.length);
      if (file.startsWith('s/')) {
        const id = file.split('/')[1];
        expect(relative).toBe(`s/${id}/preview.jpg`);
        expect(meta.get('og:url')).toBe(`${site}s/${id}/`);
      } else {
        expect(relative).toMatch(/^p\/img\/[a-z0-9-]+\/([a-z-]+\/)?[a-z0-9_-]+\.jpg$/);
        expect(meta.has('og:url')).toBe(false);
      }
    }
    expect(files.filter((f) => f.startsWith('s/'))).toEqual(setStubs().map((s) => s.path).sort());
  });

  it('writes no page for a draft set', async () => {
    const outDir = `${mkdtempSync(path.join(os.tmpdir(), 'preview-pages-'))}/`;
    dirs.push(outDir);
    const set = draft(SETS[SETS.length - 1]);
    const { pages } = await generatePreviews({ outDir, pagesOnly: true, base: '/', site: 'https://example.test/', versions: [SETS[0]], sets: [SETS[0], set] });
    expect([...pages.keys()].filter((p) => p.startsWith('s/'))).toEqual([`s/${SETS[0].id}/index.html`]);
  });
});

describe('vite.config.ts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const load = async (env: Record<string, string>) => {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    // A computed specifier keeps vite.config.ts (typed for the app's tsconfig) out of this typecheck.
    const config = new URL('../vite.config.ts', import.meta.url).href;
    return ((await import(/* @vite-ignore */ config)) as { default: { base?: string; plugins?: unknown[] } }).default;
  };

  it('builds for GitHub Pages by default and for the root with BASE_PATH=/', async () => {
    vi.stubEnv('BASE_PATH', undefined);
    expect((await load({})).base).toBe('/BrainrotTCG/');
    expect((await load({ BASE_PATH: '/' })).base).toBe('/');
  });

  it("points index.html's link-preview tags at SITE_URL", async () => {
    const config = await load({ SITE_URL: 'https://brainrottcg.pages.dev/' });
    const plugin = config.plugins!.flat().find((p) => (p as Plugin | undefined)?.name === 'site-url') as Plugin;
    const transform = plugin.transformIndexHtml as (html: string) => string;
    const meta = tags(transform(INDEX_HTML));
    expect(meta.get('og:url')).toBe('https://brainrottcg.pages.dev/');
    expect(meta.get('og:image')).toBe('https://brainrottcg.pages.dev/og-image.jpg');
    expect(transform(INDEX_HTML)).not.toContain('evanlin23.github.io');
  });
});
