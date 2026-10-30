import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isOpenable, SETS } from '../src/content/sets/index.ts';
import { buildCardsCatalog, buildSetsCatalog } from './build-api.ts';
import { checkApiLinks, checkCacheContract, checkCrawlerFiles, checkFileCount, checkFirstLoad, checkManifest, checkSite, firstLoadFiles, MAX_FIRST_LOAD_BYTES, MAX_SITE_FILES, metaTags, pageUrl, type SiteCheckOptions } from './check-site.ts';
import { robotsTxt, sitemapXml } from './crawler-files.ts';
import { generatePreviews } from './preview-pages.ts';

interface Host {
  name: string;
  base: string;
  site: string;
}

// The two hosts the deploy builds for (docs/HOSTING.md).
const GITHUB: Host = { name: 'GitHub Pages', base: '/BrainrotTCG/', site: 'https://evanlin23.github.io/BrainrotTCG/' };
const CLOUDFLARE: Host = { name: 'Cloudflare Pages', base: '/', site: 'https://brainrottcg.pages.dev/' };

// Two cards of one set: 19 share pages (and 6 per card naming a modifier, in a set with modifiers),
// a set page, and no card art drawn.
const OPENABLE = SETS.find(isOpenable)!;
const SET = { ...OPENABLE, cards: OPENABLE.cards.slice(0, 2) };

const picture = (width = 1200, height = 630) => sharp({ create: { width, height, channels: 3, background: '#121114' } });
let JPEG: Buffer;
beforeAll(async () => {
  JPEG = await picture().jpeg().toBuffer();
});

/** A manifest as public/manifest.webmanifest has it: URLs relative to itself, so they hold under any base. */
const MANIFEST = { start_url: './', scope: './', icons: [{ src: 'favicon.svg' }, { src: 'icon-192.png', sizes: '192x192' }] };

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const write = (file: string, data: string | Buffer) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
};

/** Writes the preview pages for a host into outDir, and a picture for each, as `npm run build` does. */
const writePages = async (outDir: string, { base, site }: Host) => {
  const { pages } = await generatePreviews({ outDir, pagesOnly: true, base, site, versions: [SET], sets: [SET] });
  const images = new Set<string>();
  for (const page of pages.keys()) {
    const image = metaTags(readFileSync(`${outDir}${page}`, 'utf8')).get('og:image')!;
    images.add(image.slice(site.length));
  }
  for (const image of images) write(`${outDir}${image}`, JPEG);
  return { pages: [...pages.keys()], images: [...images] };
};

/** A small build for a host, laid out like `npm run build`'s: the app shell, what it loads, and the preview pages. */
const build = async (host: Host) => {
  const { base, site } = host;
  const outDir = `${mkdtempSync(path.join(os.tmpdir(), 'check-site-test-'))}/`;
  dirs.push(outDir);
  write(
    `${outDir}index.html`,
    `<!doctype html>
<html lang="en">
  <head>
    <link rel="icon" type="image/svg+xml" href="${base}favicon.svg" />
    <meta property="og:title" content="Brainrot TCG" />
    <meta property="og:url" content="${site}" />
    <meta property="og:image" content="${site}og-image.jpg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="${site}og-image.jpg" />
    <script type="module" crossorigin src="${base}assets/index-AbCd1234.js"></script>
    <link rel="stylesheet" crossorigin href="${base}assets/index-AbCd1234.css">
  </head>
  <body><div id="root"></div></body>
</html>
`,
  );
  write(`${outDir}favicon.svg`, 'icon');
  write(`${outDir}icon-192.png`, 'icon');
  write(`${outDir}manifest.webmanifest`, JSON.stringify(MANIFEST));
  write(`${outDir}assets/index-AbCd1234.js`, 'app');
  write(`${outDir}assets/index-AbCd1234.css`, `@font-face{src:url(${base}assets/font-AbCd1234.woff2) format("woff2")}body{background:url("./paper-AbCd1234.webp")}`);
  write(`${outDir}assets/font-AbCd1234.woff2`, 'font');
  write(`${outDir}assets/paper-AbCd1234.webp`, 'paper');
  write(`${outDir}og-image.jpg`, JPEG);
  write(`${outDir}robots.txt`, robotsTxt(site));
  write(`${outDir}sitemap.xml`, sitemapXml(site));
  const { pages, images } = await writePages(outDir, host);
  const options: SiteCheckOptions = { outDir, base, site, versions: [SET], sets: [SET] };
  return { options, outDir, pages, images };
};

const sharePicture = (images: string[]) => images.find((image) => image.startsWith('p/img/'))!;
const SET_PICTURE = `s/${SET.id}/preview.jpg`;

describe('metaTags', () => {
  it('reads a tag whatever order its attributes are in', () => {
    const html = `<meta content="https://a.example/x.jpg" property="og:image" />
<meta name="twitter:image" content='https://a.example/x.jpg'>
<meta data-x="1" content="1200" property="og:image:width"><meta property="og:title" content="A &amp; B">`;
    expect(Object.fromEntries(metaTags(html))).toEqual({
      'og:image': 'https://a.example/x.jpg',
      'twitter:image': 'https://a.example/x.jpg',
      'og:image:width': '1200',
      'og:title': 'A & B',
    });
  });
});

describe('checkCrawlerFiles', () => {
  const site = CLOUDFLARE.site;
  const sitemap = (...locs: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join('\n')}\n</urlset>\n`;

  it('passes the files the build writes', () => {
    expect(checkCrawlerFiles(site, robotsTxt(site), sitemapXml(site))).toEqual([]);
  });

  it("fails missing files, or the app's page served in their place", () => {
    const app = '<!doctype html>\n<html lang="en"><head></head></html>';
    expect(checkCrawlerFiles(site, undefined, undefined)).toEqual([
      { path: 'robots.txt', error: 'Missing' },
      { path: 'sitemap.xml', error: 'Missing' },
    ]);
    expect(checkCrawlerFiles(site, app, app)).toEqual([
      { path: 'robots.txt', error: 'Is an HTML page' },
      { path: 'sitemap.xml', error: "Isn't a sitemap (an XML urlset)" },
    ]);
  });

  it('fails a robots.txt that blocks the site or names another sitemap', () => {
    expect(checkCrawlerFiles(site, 'User-agent: *\nDisallow: /\n', sitemapXml(site))).toEqual([
      { path: 'robots.txt', error: `Doesn't name the sitemap at ${site}sitemap.xml` },
      { path: 'robots.txt', error: 'Blocks the whole site' },
    ]);
    expect(checkCrawlerFiles(site, robotsTxt(GITHUB.site), sitemapXml(site))).toEqual([{ path: 'robots.txt', error: `Doesn't name the sitemap at ${site}sitemap.xml` }]);
  });

  it('fails a sitemap that leaves out the app, or lists another site, share, set or in-app address', () => {
    expect(checkCrawlerFiles(site, robotsTxt(site), sitemap(GITHUB.site, `${site}p/0123abcd.html`, `${site}s/genesis/`, `${site}#/cards`))).toEqual([
      { path: 'sitemap.xml', error: `Doesn't list the app at ${site}` },
      { path: 'sitemap.xml', error: `Lists ${GITHUB.site}, not under SITE_URL ${site}` },
      { path: 'sitemap.xml', error: `Lists ${site}p/0123abcd.html, a share, set or in-app address` },
      { path: 'sitemap.xml', error: `Lists ${site}s/genesis/, a share, set or in-app address` },
      { path: 'sitemap.xml', error: `Lists ${site}#/cards, a share, set or in-app address` },
    ]);
  });
});

describe('pageUrl', () => {
  it('gives a directory page its directory and any other page its own name', () => {
    const site = CLOUDFLARE.site;
    expect(pageUrl(site, 'index.html')).toBe(site);
    expect(pageUrl(site, 's/genesis/index.html')).toBe(`${site}s/genesis/`);
    expect(pageUrl(site, 'p/0123abcd.html')).toBe(`${site}p/0123abcd.html`);
  });
});

describe('checkSite', () => {
  it.each([GITHUB, CLOUDFLARE])('passes a build for $name', async (host) => {
    const { options, pages, images } = await build(host);
    expect(pages).toHaveLength(20 + (SET.modifiers ? 12 : 0));
    expect(images).toContain(SET_PICTURE);
    expect(await checkSite(options)).toEqual({ pages: pages.length + 1, images: images.length + 1, errors: [] });
  });

  it.each([GITHUB, CLOUDFLARE])('checks a build for $name the same whether SITE_URL ends in / or not', async (host) => {
    const { options, pages, images } = await build(host);
    const result = { pages: pages.length + 1, images: images.length + 1, errors: [] };
    expect(await checkSite({ ...options, site: host.site.replace(/\/$/, '') })).toEqual(result);
    expect(await checkSite({ ...options, site: host.site })).toEqual(result);
  });

  it('passes link-preview tags written in another attribute order', async () => {
    const { options, outDir } = await build(CLOUDFLARE);
    const file = `${outDir}index.html`;
    writeFileSync(file, readFileSync(file, 'utf8').replace(/<meta (property|name)="([^"]+)" content="([^"]*)" \/>/g, '<meta content="$3" $1="$2" />'));
    expect(readFileSync(file, 'utf8')).toContain(`<meta content="${CLOUDFLARE.site}og-image.jpg" property="og:image" />`);
    expect((await checkSite(options)).errors).toEqual([]);
  });

  it("passes the API catalogs build-api makes, and fails one naming an assets/ file the build doesn't have", async () => {
    const { options, outDir } = await build(GITHUB);
    write(`${outDir}api/sets.json`, JSON.stringify(buildSetsCatalog()));
    write(`${outDir}api/cards.json`, JSON.stringify(buildCardsCatalog()));
    // Player submissions are free text, not addresses this build makes.
    write(`${outDir}api/hall-of-fame.json`, JSON.stringify([{ name: 'assets/cards/genesis/x.webp' }]));
    expect((await checkSite(options)).errors).toEqual([]);

    const [card] = buildCardsCatalog().cards;
    write(`${outDir}api/cards.json`, JSON.stringify({ cards: [{ ...card, image: `assets/cards/${card.setId}/${card.id}.webp` }] }));
    expect((await checkSite(options)).errors).toEqual([
      { path: 'api/cards.json', error: `Names assets/cards/${card.setId}/${card.id}.webp, which isn't in the build` },
    ]);
  });

  it('fails a page whose og:image has no size', async () => {
    const { options, outDir } = await build(GITHUB);
    const file = `${outDir}index.html`;
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\s*<meta property="og:image:height"[^>]*>/, ''));
    expect((await checkSite(options)).errors).toEqual([{ path: 'index.html', error: 'og:image og-image.jpg needs og:image:width and og:image:height (has 1200 and none)' }]);
  });

  it("fails an og:url that isn't the page's own address", async () => {
    const { options, outDir } = await build(CLOUDFLARE);
    const setPage = `s/${SET.id}/index.html`;
    for (const [file, from, to] of [
      ['index.html', `content="${CLOUDFLARE.site}"`, `content="${CLOUDFLARE.site}p/"`],
      [setPage, `${CLOUDFLARE.site}s/${SET.id}/`, CLOUDFLARE.site],
    ]) {
      writeFileSync(`${outDir}${file}`, readFileSync(`${outDir}${file}`, 'utf8').replace(from, to));
    }
    expect((await checkSite(options)).errors).toEqual([
      { path: 'index.html', error: `og:url is ${CLOUDFLARE.site}p/, not ${CLOUDFLARE.site}` },
      { path: setPage, error: `og:url is ${CLOUDFLARE.site}, not ${CLOUDFLARE.site}s/${SET.id}/` },
    ]);
  });

  it('fails a build whose index.html has no og:url, or that has no robots.txt or sitemap.xml', async () => {
    const { options, outDir } = await build(CLOUDFLARE);
    const file = `${outDir}index.html`;
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\s*<meta property="og:url"[^>]*>/, ''));
    unlinkSync(`${outDir}robots.txt`);
    unlinkSync(`${outDir}sitemap.xml`);
    expect((await checkSite(options)).errors).toEqual([
      { path: 'index.html', error: 'Has no og:url' },
      { path: 'robots.txt', error: 'Missing' },
      { path: 'sitemap.xml', error: 'Missing' },
    ]);
  });

  it("fails a link-preview picture that isn't a JPEG", async () => {
    const { options, outDir } = await build(GITHUB);
    const file = `${outDir}index.html`;
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('og-image.jpg', 'og-image.webp'));
    write(`${outDir}og-image.webp`, await picture().webp().toBuffer());
    expect((await checkSite(options)).errors).toEqual([{ path: 'index.html', error: `og:image ${GITHUB.site}og-image.webp isn't a JPEG` }]);
  });

  it('fails a build whose manifest is missing or points outside the base', async () => {
    const { options, outDir } = await build(GITHUB);
    writeFileSync(`${outDir}manifest.webmanifest`, JSON.stringify({ ...MANIFEST, start_url: '/' }));
    expect((await checkSite(options)).errors.map((e) => e.error)).toEqual(['start_url / resolves to https://x.test/, outside BASE_PATH /BrainrotTCG/']);
    unlinkSync(`${outDir}manifest.webmanifest`);
    expect((await checkSite(options)).errors).toEqual([{ path: 'manifest.webmanifest', error: 'Missing' }]);
  });

  it('fails a directory that is not a build', async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'check-site-test-'));
    dirs.push(outDir);
    const { errors } = await checkSite({ outDir, base: '/', site: CLOUDFLARE.site, versions: [SET], sets: [SET] });
    expect(errors).toEqual([{ path: 'index.html', error: expect.stringContaining('Missing') }]);
  });

  it.each([
    { problem: 'missing', spoil: async (file: string) => unlinkSync(file), error: 'File does not exist' },
    { problem: 'empty', spoil: async (file: string) => writeFileSync(file, ''), error: 'File is empty (0 bytes)' },
    { problem: 'cut short', spoil: async (file: string) => writeFileSync(file, JPEG.subarray(0, JPEG.length >> 1)), error: expect.any(String) },
    { problem: 'a PNG', spoil: async (file: string) => writeFileSync(file, await picture().png().toBuffer()), error: 'Expected JPEG, got png' },
    {
      problem: 'the wrong size',
      spoil: async (file: string) => writeFileSync(file, await picture(1200, 600).jpeg().toBuffer()),
      error: 'Expected 1200x630, got 1200x600',
    },
  ])('fails a share picture, a set picture or the site picture that is $problem', async ({ spoil, error }) => {
    const { options, outDir, images } = await build(GITHUB);
    const spoilt = [sharePicture(images), SET_PICTURE, 'og-image.jpg'];
    for (const image of spoilt) await spoil(`${outDir}${image}`);
    const { errors } = await checkSite(options);
    expect(errors).toHaveLength(spoilt.length);
    expect(errors).toEqual(expect.arrayContaining(spoilt.map((image) => ({ path: image, error }))));
  });

  it('fails a build missing a share page or a set page', async () => {
    const { options, outDir, pages } = await build(CLOUDFLARE);
    const share = pages.find((page) => page.startsWith('p/'))!;
    const setPage = `s/${SET.id}/index.html`;
    unlinkSync(`${outDir}${share}`);
    unlinkSync(`${outDir}${setPage}`);
    const { errors } = await checkSite(options);
    expect(errors).toEqual(
      expect.arrayContaining([
        { path: share, error: expect.stringMatching(new RegExp(`^Missing: the preview page for ${SET.id}/`)) },
        { path: setPage, error: `Missing: the preview page for set ${SET.id}` },
      ]),
    );
    expect(errors).toHaveLength(2);
  });

  it.each([GITHUB, CLOUDFLARE])("fails a build for $name whose index.html loads more than the first-load budget up front (#776)", async (host) => {
    const { options, outDir } = await build(host);
    // Random bytes don't compress, so this script alone is over the budget gzipped.
    write(`${outDir}assets/index-AbCd1234.js`, randomBytes(MAX_FIRST_LOAD_BYTES).toString('base64'));
    const { errors } = await checkSite(options);
    expect(errors).toEqual([{ path: 'index.html', error: expect.stringMatching(/^Loads [\d,]+ bytes \(gzip\) before the app can render, over 280,000 \(MAX_FIRST_LOAD_BYTES, #776\)$/) }]);
  });

  it('fails a build missing what its pages or stylesheets load', async () => {
    const { options, outDir } = await build(GITHUB);
    unlinkSync(`${outDir}assets/index-AbCd1234.js`);
    unlinkSync(`${outDir}assets/paper-AbCd1234.webp`);
    const { errors } = await checkSite(options);
    expect(errors).toEqual([
      { path: 'index.html', error: "Links to /BrainrotTCG/assets/index-AbCd1234.js, which isn't in the build (assets/index-AbCd1234.js)" },
      { path: 'assets/index-AbCd1234.css', error: "Links to ./paper-AbCd1234.webp, which isn't in the build (assets/paper-AbCd1234.webp)" },
    ]);
  });

  it('fails a page that previews without a large picture or a title', async () => {
    const { options, outDir } = await build(CLOUDFLARE);
    const file = `${outDir}index.html`;
    writeFileSync(file, readFileSync(file, 'utf8')
      .replace('content="summary_large_image"', 'content="summary"')
      .replace(/\s*<meta property="og:title"[^>]*>/, ''));
    expect((await checkSite(options)).errors).toEqual([
      { path: 'index.html', error: 'Has no og:title' },
      { path: 'index.html', error: 'twitter:card is summary, not summary_large_image' },
    ]);
  });

  it("fails a set's page that opens the app somewhere other than that set", async () => {
    const { options, outDir } = await build(GITHUB);
    const setPage = `s/${SET.id}/index.html`;
    const file = `${outDir}${setPage}`;
    writeFileSync(file, readFileSync(file, 'utf8').replace(`"#/set/${SET.id}"`, '""'));
    expect((await checkSite(options)).errors).toEqual([{ path: setPage, error: `Opens the app at '', not '#/set/${SET.id}'` }]);
  });

  it('fails code or styles a page loads from outside assets/, and unhashed files that would be cached forever', async () => {
    const { options, outDir } = await build(GITHUB);
    const file = `${outDir}index.html`;
    writeFileSync(file, readFileSync(file, 'utf8').replace('</head>', '<script src="/BrainrotTCG/app.js"></script><script type="module" src="assets/index-AbCd1234.js"></script><link rel="stylesheet" href="https://cdn.example/x.css"></head>'));
    write(`${outDir}app.js`, 'app');
    write(`${outDir}assets/logo.png`, 'logo');
    write(`${outDir}cards/a.webp`, 'card');
    expect((await checkSite(options)).errors).toEqual([
      { path: 'index.html', error: "Loads /BrainrotTCG/app.js, outside /BrainrotTCG/assets/, so it isn't hashed" },
      { path: 'index.html', error: "Loads assets/index-AbCd1234.js, outside /BrainrotTCG/assets/, so it isn't hashed" },
      { path: 'index.html', error: "Loads https://cdn.example/x.css, outside /BrainrotTCG/assets/, so it isn't hashed" },
      { path: 'assets/logo.png', error: "Has no content hash in its name, but assets/ is cached as if it never changes" },
      { path: 'cards/a.webp', error: 'Keeps its name between deploys outside the top level, p/, s/ and api/ (the cache contract in docs/HOSTING.md)' },
    ]);
  });

  describe.each([
    { built: GITHUB, other: CLOUDFLARE },
    { built: CLOUDFLARE, other: GITHUB },
  ])('in a build for $built.name', ({ built, other }) => {
    it(`fails preview pages that forward to ${other.base}`, async () => {
      const { options, outDir, pages } = await build(built);
      await writePages(outDir, { ...other, site: built.site });
      const { errors } = await checkSite(options);
      for (const page of pages) {
        expect(errors).toContainEqual({ path: page, error: `Forwards to ${other.base}, not BASE_PATH ${built.base}` });
      }
      expect(new Set(errors.map((e) => e.path))).toEqual(new Set(pages));
    });

    it(`fails preview pages whose pictures are at ${other.site}`, async () => {
      const { options, outDir, pages, images } = await build(built);
      await writePages(outDir, { ...other, base: built.base });
      const { errors, images: decoded } = await checkSite(options);
      for (const page of pages) {
        expect(errors).toContainEqual({ path: page, error: expect.stringMatching(new RegExp(`^og:image is ${other.site}.*, not under SITE_URL ${built.site}$`)) });
      }
      expect(errors).toContainEqual({ path: `s/${SET.id}/index.html`, error: `og:url is ${other.site}s/${SET.id}/, not ${built.site}s/${SET.id}/` });
      expect(decoded).toBeLessThan(images.length);
    });

    it(`fails the whole build when checked as ${other.name}'s`, async () => {
      const { options } = await build(built);
      const { errors } = await checkSite({ ...options, base: other.base, site: other.site });
      expect(errors).toContainEqual({ path: 'index.html', error: expect.stringMatching(/^Links to .*assets\/index-AbCd1234\.js/) });
      expect(errors).toContainEqual({ path: 'index.html', error: `og:image is ${built.site}og-image.jpg, not under SITE_URL ${other.site}` });
      expect(errors).toContainEqual({ path: `s/${SET.id}/index.html`, error: `Forwards to ${built.base}, not BASE_PATH ${other.base}` });
    });
  });
});

describe('checkManifest', () => {
  const present = new Set(['index.html', 'favicon.svg', 'icon-192.png']);
  const check = (manifest: unknown, base: string) => checkManifest(JSON.stringify(manifest), base, present);

  it.each([GITHUB, CLOUDFLARE])('passes URLs relative to the manifest, under $name', ({ base }) => {
    expect(check(MANIFEST, base)).toEqual([]);
  });

  it('fails root-absolute URLs under a subpath, which Vite copies from public/ unchanged', () => {
    const errors = check({ start_url: '/', scope: '/', icons: [{ src: '/icon-192.png' }] }, GITHUB.base);
    expect(errors.map((e) => e.error)).toEqual([
      'start_url / resolves to https://x.test/, outside BASE_PATH /BrainrotTCG/',
      'scope / resolves to https://x.test/, outside BASE_PATH /BrainrotTCG/',
      'icon src /icon-192.png resolves to https://x.test/icon-192.png, outside BASE_PATH /BrainrotTCG/',
    ]);
  });

  it('fails an icon that is not in the build, another site, or a start_url outside its scope', () => {
    expect(check({ ...MANIFEST, icons: [{ src: 'icon-512.png' }] }, GITHUB.base).map((e) => e.error)).toEqual([
      "Icon icon-512.png resolves to /BrainrotTCG/icon-512.png, which isn't in the build",
    ]);
    expect(check({ ...MANIFEST, icons: [{ src: 'https://elsewhere.test/BrainrotTCG/icon-192.png' }] }, GITHUB.base)[0].error).toMatch(/outside BASE_PATH/);
    expect(check({ ...MANIFEST, scope: './sub/' }, GITHUB.base).map((e) => e.error)).toEqual([
      'start_url /BrainrotTCG/ is outside scope /BrainrotTCG/sub/',
      "/BrainrotTCG/sub/ isn't a page in the build",
    ]);
  });

  it('fails a missing, unparsable or iconless manifest', () => {
    expect(checkManifest(undefined, GITHUB.base, present)).toEqual([{ path: 'manifest.webmanifest', error: 'Missing' }]);
    expect(checkManifest('{', GITHUB.base, present)).toEqual([{ path: 'manifest.webmanifest', error: "Isn't valid JSON" }]);
    expect(check({ ...MANIFEST, icons: [] }, GITHUB.base).map((e) => e.error)).toEqual(['Has no icons']);
  });
});

describe('checkApiLinks', () => {
  const present = new Set(['assets/locked-in-alien-AbCd1234.webp']);
  const { base, site } = GITHUB;

  it('passes hashed files in the build, however they are addressed, and ignores other text', () => {
    const json = { cards: [{ image: 'assets/locked-in-alien-AbCd1234.webp', a: `${base}assets/locked-in-alien-AbCd1234.webp`, b: `${site}assets/locked-in-alien-AbCd1234.webp`, caption: 'Your time is limited', n: 3 }] };
    expect(checkApiLinks('api/cards.json', json, present, base, site)).toEqual([]);
  });

  it("fails an address that isn't in the build, as an unhashed card path never is", () => {
    expect(checkApiLinks('api/cards.json', [{ image: 'assets/cards/genesis/gone.webp' }, { image: `${site}assets/gone-AbCd1234.webp` }], present, base, site)).toEqual([
      { path: 'api/cards.json', error: "Names assets/cards/genesis/gone.webp, which isn't in the build" },
      { path: 'api/cards.json', error: `Names ${site}assets/gone-AbCd1234.webp, which isn't in the build` },
    ]);
  });
});

describe('checkFileCount', () => {
  it('passes up to 19,000 files and fails a build with more, under Cloudflare Pages\' 20,000', () => {
    expect(MAX_SITE_FILES).toBe(19_000);
    expect(checkFileCount(7_800)).toEqual([]);
    expect(checkFileCount(MAX_SITE_FILES)).toEqual([]);
    expect(checkFileCount(MAX_SITE_FILES + 1)).toEqual([{ path: '.', error: 'Has 19,001 files, over 19,000 (Cloudflare Pages takes 20,000 per deploy)' }]);
    expect(checkFileCount(4, 3)).toHaveLength(1);
  });
});

describe('first-load budget', () => {
  it.each([GITHUB, CLOUDFLARE])("counts the scripts, modulepreloads and stylesheets index.html loads for $name, not what it only links to", ({ base }) => {
    const html = `<link rel="icon" href="${base}favicon.svg" />
      <script type="module" crossorigin src="${base}assets/index-AbCd1234.js"></script>
      <link rel="modulepreload" crossorigin href="${base}assets/proof-AbCd1234.js">
      <link crossorigin rel="stylesheet" href="${base}assets/index-AbCd1234.css">
      <link rel="manifest" href="${base}manifest.webmanifest" />
      <script src="https://example.com/elsewhere.js"></script>`;
    expect(firstLoadFiles(html, base)).toEqual(['assets/index-AbCd1234.js', 'assets/proof-AbCd1234.js', 'assets/index-AbCd1234.css']);
  });

  it('passes up to the budget and fails a first load over it', () => {
    expect(MAX_FIRST_LOAD_BYTES).toBe(280_000);
    expect(checkFirstLoad(MAX_FIRST_LOAD_BYTES)).toEqual([]);
    expect(checkFirstLoad(MAX_FIRST_LOAD_BYTES + 1)).toEqual([{ path: 'index.html', error: 'Loads 280,001 bytes (gzip) before the app can render, over 280,000 (MAX_FIRST_LOAD_BYTES, #776)' }]);
    expect(checkFirstLoad(4, 3)).toHaveLength(1);
  });
});

describe('checkCacheContract', () => {
  const files = ['index.html', 'og-image.jpg', 'assets/index-AbCd1234.js', 'assets/cards/genesis/a-AbCd_-12.webp', 'p/genesis.html', 's/genesis/index.html', 'api/sets.json', 'api/cards.json', '_headers'];

  it('passes the files a build names, with no _headers or one that keeps only assets/ forever', () => {
    expect(checkCacheContract(files, '/', undefined)).toEqual([]);
    expect(checkCacheContract(files, '/', '# cache\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  Cache-Control: no-cache\n')).toEqual([]);
  });

  it('fails a _headers that keeps a renamable file forever, or leaves assets/ out', () => {
    expect(checkCacheContract(files, '/BrainrotTCG/', '/BrainrotTCG/*\n  Cache-Control: max-age=31536000, immutable\n')).toEqual([
      { path: '_headers', error: 'Marks /BrainrotTCG/* immutable; only /BrainrotTCG/assets/* is hashed' },
      { path: '_headers', error: 'Caches /BrainrotTCG/* for 31536000s; only /BrainrotTCG/assets/* is hashed, so the rest must revalidate within 86400s' },
      { path: '_headers', error: "Doesn't mark /BrainrotTCG/assets/* immutable" },
    ]);
  });

  it('fails a _headers that caches a renamable file for longer than a day, even without immutable', () => {
    const assets = '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n';
    expect(checkCacheContract(files, '/', `${assets}/*\n  Cache-Control: max-age=31536000\n`)).toEqual([
      { path: '_headers', error: 'Caches /* for 31536000s; only /assets/* is hashed, so the rest must revalidate within 86400s' },
    ]);
    expect(checkCacheContract(files, '/', `${assets}/index.html\n  Cache-Control: public, max-age=3600, s-maxage=604800\n`)).toEqual([
      { path: '_headers', error: 'Caches /index.html for 604800s; only /assets/* is hashed, so the rest must revalidate within 86400s' },
    ]);
    expect(checkCacheContract(files, '/', `${assets}/*\n  Cache-Control: public, max-age=3600\n/s/*\n  Cache-Control: max-age=86400\n`)).toEqual([]);
  });

  it("fails a name in assets/ that only looks hashed, because it's a source file's own name", () => {
    const words = ['assets/finish-rainbows.webp', 'assets/cards/x/card-backside.webp'];
    expect(checkCacheContract([...files, ...words], '/', undefined, new Set(['finish-rainbows.webp', 'card-backside.webp']))).toEqual(
      words.map((path) => ({ path, error: 'Has no content hash in its name, but assets/ is cached as if it never changes' })),
    );
    // The same shape that isn't any source file's name is Vite's: an all-lowercase hash is one.
    expect(checkCacheContract(['assets/finish-rainbowz.webp'], '/', undefined, new Set(['finish-rainbows.webp']))).toEqual([]);
  });

  it("passes a hashed file's sourcemap, but not the sourcemap of a file that keeps its name", () => {
    const maps = ['assets/index-AbCd1234.js.map', 'assets/index-AbCd_-12.css.map', 'assets/chunks/pack-Zz9_Yy8-.js.map'];
    expect(checkCacheContract([...files, ...maps], '/', undefined, new Set(['index.ts', 'index.css']))).toEqual([]);
    expect(checkCacheContract(['assets/index.js.map', 'assets/cards/x/card.webp.map'], '/', undefined)).toEqual(
      ['assets/index.js.map', 'assets/cards/x/card.webp.map'].map((path) => ({ path, error: 'Has no content hash in its name, but assets/ is cached as if it never changes' })),
    );
  });

  it("fails the sourcemap of a file whose hashed-looking name is a source file's own name", () => {
    const map = 'assets/finish-rainbows.webp.map';
    expect(checkCacheContract([...files, map], '/', undefined, new Set(['finish-rainbows.webp']))).toEqual([
      { path: map, error: 'Has no content hash in its name, but assets/ is cached as if it never changes' },
    ]);
    expect(checkCacheContract([map], '/', undefined, new Set(['finish-rainbowz.webp']))).toEqual([]);
  });
});
