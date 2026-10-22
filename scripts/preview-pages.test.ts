import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_SET_VERSIONS, isOpenable, SETS } from '../src/content/sets/index.ts';
import { RARITIES_RAREST_FIRST, type SetDefinition } from '../src/engine/index.ts';
import { modifierText } from '../src/game/modifierLabels.ts';
import { cardPreviewPath, MODIFIER_TOKENS, previewPath } from '../src/game/previewLinks.ts';
import { setIdFromHash } from '../src/game/route.ts';
import { escape, generatePreviews, optionsFromEnv, page, PREVIEW_CACHE_VERSION, previewCacheContract, setStubs } from './preview-pages.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INDEX_HTML = readFileSync(`${ROOT}index.html`, 'utf8');

/** The link-preview tags a page has, by property or name. */
const tags = (html: string): Map<string, string> =>
  new Map([...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[^"]+)" content="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const redirectTarget = (html: string) => JSON.parse(/location\.replace\(("[^"]*")/.exec(html)![1]) as string;
/** Where a page goes when its link carries no pull. */
const landingOf = (html: string) => JSON.parse(/: ("[^"]*")\)\);<\/script>/.exec(html)![1]) as string;

// The two hosts (docs/HOSTING.md), and the old GitHub Pages address after a move, whose pages
// forward through its redirect page and show pictures from the new address.
const HOSTS = [
  { name: 'GitHub Pages', base: '/BrainrotTCG/', site: 'https://evanlin23.github.io/BrainrotTCG/' },
  { name: 'Cloudflare Pages', base: '/', site: 'https://brainrottcg.pages.dev/' },
  { name: 'the old address after a move', base: '/BrainrotTCG/', site: 'https://brainrottcg.pages.dev/' },
];

const draft = (set: SetDefinition): SetDefinition => ({ ...set, id: `${set.id}-draft`, draft: true });
const archived = (set: SetDefinition): SetDefinition => ({ ...set, id: `${set.id}-archived`, archivedAt: '2020-01-01' });
const OPENABLE = SETS.find(isOpenable)!;

describe('optionsFromEnv', () => {
  it("defaults to GitHub Pages' path and production's address, like vite.config.ts", () => {
    expect(optionsFromEnv({})).toEqual({ outDir: `${ROOT}dist/`, pagesOnly: false, base: '/BrainrotTCG/', site: 'https://brainrottcg.pages.dev/' });
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
  it('has a page for each released set, archived ones included, from the set registry', () => {
    const stubs = setStubs();
    expect(stubs.map((s) => s.setId)).toEqual(SETS.filter((s) => !s.draft).map((s) => s.id));
    // Genesis is archived; its page stays, so the live s/genesis/ and links shared to it don't 404.
    expect(stubs.map((s) => s.setId)).toContain('genesis');
    for (const stub of stubs) {
      expect(stub.path).toBe(`s/${stub.setId}/index.html`);
      expect(stub.url).toBe(`s/${stub.setId}/`);
      expect(stub.imagePath).toBe(`s/${stub.setId}/preview.jpg`);
      expect(stub.landing).toBe(`#/set/${stub.setId}`);
      expect(setIdFromHash(stub.landing)).toBe(stub.setId);
    }
  });

  it('leaves draft sets out but keeps archived ones, so shared links to them still load', () => {
    const withMore = [...SETS, draft(SETS[SETS.length - 1]), archived(OPENABLE)];
    expect(setStubs(withMore).map((s) => s.setId)).toEqual([...setStubs(SETS).map((s) => s.setId), `${OPENABLE.id}-archived`]);
    expect(setStubs([draft(OPENABLE), archived(OPENABLE)]).map((s) => s.setId)).toEqual([`${OPENABLE.id}-archived`]);
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

  // Every set registered today has a tagline and at least five cards, so the loop above can't see these.
  it('names a set without a tagline, and shows every card of a set smaller than a pack', () => {
    const { tagline: _tagline, ...untagged } = OPENABLE;
    const small = { ...untagged, id: 'small', name: 'Small Set', cards: OPENABLE.cards.slice(0, 3) };
    const [stub] = setStubs([small]);
    expect(stub.description).toBe(`Small Set (${small.era}, 3 cards). Every pull is verifiable.`);
    expect([...stub.cardIds].sort()).toEqual(small.cards.map((c) => c.id).sort());
  });
});

describe('previewCacheContract', () => {
  const script = 'the script';
  const versions = { vips: '8.18.7', sharp: '0.35.5' };

  it('is a stable SHA-256 of the script, sharp and the cache version', () => {
    expect(previewCacheContract(script, versions)).toMatch(/^[0-9a-f]{64}$/);
    expect(previewCacheContract(script, versions)).toBe(previewCacheContract(script, { ...versions }, PREVIEW_CACHE_VERSION));
    expect(previewCacheContract()).toBe(previewCacheContract());
  });

  it('changes with the script, any of sharp\'s versions, or PREVIEW_CACHE_VERSION', () => {
    const base = previewCacheContract(script, versions);
    expect(previewCacheContract(`${script} `, versions)).not.toBe(base);
    expect(previewCacheContract(script, { ...versions, vips: '8.18.8' })).not.toBe(base);
    expect(previewCacheContract(script, { ...versions, sharp: '0.35.6' })).not.toBe(base);
    expect(previewCacheContract(script, versions, PREVIEW_CACHE_VERSION + 1)).not.toBe(base);
  });

  // A cache drawn under another contract must never come back, not even through restore-keys.
  it.each(['ci', 'deploy', 'browser-tests', 'performance-baseline'])('starts every preview cache key and restore prefix with it in %s.yml', (name) => {
    const workflow = readFileSync(`${ROOT}.github/workflows/${name}.yml`, 'utf8');
    const caches = [...workflow.matchAll(/- uses: actions\/cache[^\n]*\n\s+with:\n\s+path: \.cache\/previews\n\s+key: (.*)\n\s+restore-keys: (.*)\n/g)];
    expect(caches.length).toBe(1);
    const [step, key, restore] = caches[0];
    const contract = '${{ steps.previews.outputs.contract }}';
    expect(restore).toBe(`previews-${contract}-`);
    expect(key.startsWith(restore)).toBe(true);
    for (const input of ["'scripts/preview-pages.ts'", "'src/game/previewLinks.ts'", "'src/engine/**'", "'src/content/sets/index.ts'", "'src/content/sets/*/*.json'", "'src/content/sets/*/cards/*'", "'src/assets/images/card_back.webp'", "'package-lock.json'"]) {
      expect(key).toContain(input);
    }
    const before = workflow.slice(0, workflow.indexOf(step));
    expect(before).toMatch(/- id: previews\n\s+run: \|\n\s+contract=\$\(npx tsx scripts\/preview-pages\.ts --cache-contract\)\n\s+echo "contract=\$contract" >> "\$GITHUB_OUTPUT"\n\s*$/);
    expect(before.indexOf('- run: npm ci')).toBeGreaterThan(-1);
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
    expect(landingOf(html)).toBe('');
  });

  it.each(HOSTS)("opens a set's page on that set on $name, unless its link carries a pull", ({ base }) => {
    const html = page({ title: 't', description: 'd', image: 'https://example.test/i.jpg', landing: '#/set/genesis' }, base);
    expect(redirectTarget(html)).toBe(base);
    expect(landingOf(html)).toBe('#/set/genesis');
    expect(html).toContain(`<a href="${base}#/set/genesis">Open Brainrot TCG</a>`);
    const forward = /<script>(location\.replace\(.*\);)<\/script>/.exec(html)![1];
    const run = (hash: string) => {
      let target = '';
      new Function('location', forward)({ hash, replace: (to: string) => { target = to; } });
      return target;
    };
    expect(run('')).toBe(`${base}#/set/genesis`);
    expect(run('#/pull/abc')).toBe(`${base}#/pull/abc`);
    expect(run('#/other')).toBe(`${base}#/set/genesis`);
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
        expect(landingOf(html)).toBe(`#/set/${id}`);
      } else {
        expect(landingOf(html)).toBe('');
        expect(relative).toMatch(/^p\/img\/[a-z0-9-]+\/([a-z-]+\/)?[a-z0-9_-]+\.jpg$/);
        expect(meta.has('og:url')).toBe(false);
      }
    }
    expect(files.filter((f) => f.startsWith('s/'))).toEqual(setStubs().map((s) => s.path).sort());
  });

  it("writes a page per modifier for each card of a set with modifiers, naming it, with the card's own picture", async () => {
    const outDir = `${mkdtempSync(path.join(os.tmpdir(), 'preview-pages-'))}/`;
    dirs.push(outDir);
    const withModifiers = ALL_SET_VERSIONS.find((set) => set.modifiers)!;
    const genesis = ALL_SET_VERSIONS.find((set) => set.id === 'genesis')!;
    expect(genesis.modifiers).toBeFalsy();
    const base = '/BrainrotTCG/';
    const { pages } = await generatePreviews({ outDir, pagesOnly: true, base, site: 'https://example.test/', versions: [genesis, withModifiers], sets: [] });
    const html = (file: string) => readFileSync(`${outDir}${file}`, 'utf8');

    const variants = new Set<string>();
    for (const card of withModifiers.cards) {
      const plain = tags(html(cardPreviewPath(withModifiers.id, card.id)));
      for (const token of MODIFIER_TOKENS) {
        const file = cardPreviewPath(withModifiers.id, card.id, token);
        variants.add(file);
        expect(pages.get(file)).toBe(`${withModifiers.id}/${card.id}/${token}`);
        const meta = tags(html(file));
        expect(meta.get('og:title')).toBe(escape(`${modifierText(token)} ${card.name} · ${withModifiers.name}`));
        expect(meta.get('twitter:title')).toBe(meta.get('og:title'));
        expect(meta.get('og:description')!.startsWith(escape(`${modifierText(token)} ${card.name} (`))).toBe(true);
        expect(meta.get('twitter:description')).toBe(meta.get('og:description'));
        expect(meta.get('og:image')).toBe(plain.get('og:image'));
        expect(meta.get('twitter:image')).toBe(plain.get('og:image'));
        // Like every pull page, it forwards with the pull in its '#'.
        expect(redirectTarget(html(file))).toBe(base);
        expect(landingOf(html(file))).toBe('');
      }
    }
    expect(variants.size).toBe(withModifiers.cards.length * MODIFIER_TOKENS.length);
    for (const card of genesis.cards) {
      for (const token of MODIFIER_TOKENS) expect(pages.has(cardPreviewPath(genesis.id, card.id, token))).toBe(false);
    }
    // No new pictures: every picture a modifier page shows, a page without one shows too.
    const pictures = (files: string[]) => new Set(files.map((file) => tags(html(file)).get('og:image')));
    expect(pictures([...pages.keys()])).toEqual(pictures([...pages.keys()].filter((file) => !variants.has(file))));
  });

  it('writes a page for an archived set but none for a draft set', async () => {
    const outDir = `${mkdtempSync(path.join(os.tmpdir(), 'preview-pages-'))}/`;
    dirs.push(outDir);
    const sets = [OPENABLE, draft(SETS[SETS.length - 1]), archived(OPENABLE)];
    const { pages } = await generatePreviews({ outDir, pagesOnly: true, base: '/', site: 'https://example.test/', versions: [OPENABLE], sets });
    expect([...pages.keys()].filter((p) => p.startsWith('s/'))).toEqual([`s/${OPENABLE.id}/index.html`, `s/${OPENABLE.id}-archived/index.html`]);
    expect(landingOf(readFileSync(`${outDir}s/${OPENABLE.id}-archived/index.html`, 'utf8'))).toBe(`#/set/${OPENABLE.id}-archived`);
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

  const sitePlugin = async (env: Record<string, string | undefined>) => {
    vi.stubEnv('SITE_URL', undefined);
    const config = await load(env as Record<string, string>);
    return config.plugins!.flat().find((p) => (p as Plugin | undefined)?.name === 'site-url') as Plugin;
  };
  const emitted = (plugin: Plugin) => {
    const files = new Map<string, string>();
    const emitFile = ({ fileName, source }: { fileName: string; source: string }) => files.set(fileName, source);
    (plugin.generateBundle as (this: unknown) => void).call({ emitFile });
    return files;
  };

  it("names production by default: index.html's checked-in tags are production's, and a build without SITE_URL keeps them", async () => {
    expect(INDEX_HTML).not.toContain('evanlin23.github.io');
    expect(tags(INDEX_HTML).get('og:url')).toBe('https://brainrottcg.pages.dev/');
    const transform = (await sitePlugin({})).transformIndexHtml as (html: string) => string;
    expect(transform(INDEX_HTML)).toBe(INDEX_HTML);
  });

  it('writes robots.txt and a sitemap of the app alone, at SITE_URL or production', async () => {
    const production = emitted(await sitePlugin({}));
    expect(production.get('robots.txt')).toBe('User-agent: *\nAllow: /\n\nSitemap: https://brainrottcg.pages.dev/sitemap.xml\n');
    expect([...production.get('sitemap.xml')!.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1])).toEqual(['https://brainrottcg.pages.dev/']);
    const github = emitted(await sitePlugin({ SITE_URL: 'https://evanlin23.github.io/BrainrotTCG' }));
    expect(github.get('robots.txt')).toContain('Sitemap: https://evanlin23.github.io/BrainrotTCG/sitemap.xml\n');
    expect(github.get('sitemap.xml')).toContain('<loc>https://evanlin23.github.io/BrainrotTCG/</loc>');
  });
});
