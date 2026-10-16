import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETS } from '../src/content/sets/index.ts';
import { checkSite, metaTags, type SiteCheckOptions } from './check-site.ts';
import { generatePreviews } from './preview-pages.ts';

interface Host {
  name: string;
  base: string;
  site: string;
}

// The two hosts the deploy builds for (docs/HOSTING.md).
const GITHUB: Host = { name: 'GitHub Pages', base: '/BrainrotTCG/', site: 'https://evanlin23.github.io/BrainrotTCG/' };
const CLOUDFLARE: Host = { name: 'Cloudflare Pages', base: '/', site: 'https://brainrottcg.pages.dev/' };

// Two cards of one set: 19 share pages and a set page, and no card art drawn.
const SET = { ...SETS[0], cards: SETS[0].cards.slice(0, 2) };

const picture = (width = 1200, height = 630) => sharp({ create: { width, height, channels: 3, background: '#121114' } });
let JPEG: Buffer;
beforeAll(async () => {
  JPEG = await picture().jpeg().toBuffer();
});

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
    <link rel="icon" type="image/png" href="${base}logo.png" />
    <meta property="og:url" content="${site}" />
    <meta property="og:image" content="${site}og-image.jpg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:image" content="${site}og-image.jpg" />
    <script type="module" crossorigin src="${base}assets/index.js"></script>
    <link rel="stylesheet" crossorigin href="${base}assets/index.css">
  </head>
  <body><div id="root"></div></body>
</html>
`,
  );
  write(`${outDir}logo.png`, 'logo');
  write(`${outDir}assets/index.js`, 'app');
  write(`${outDir}assets/index.css`, `@font-face{src:url(${base}assets/font.woff2) format("woff2")}body{background:url("./paper.webp")}`);
  write(`${outDir}assets/font.woff2`, 'font');
  write(`${outDir}assets/paper.webp`, 'paper');
  write(`${outDir}og-image.jpg`, JPEG);
  const { pages, images } = await writePages(outDir, host);
  const options: SiteCheckOptions = { outDir, base, site, versions: [SET], sets: [SET] };
  return { options, outDir, pages, images };
};

const sharePicture = (images: string[]) => images.find((image) => image.startsWith('p/img/'))!;
const SET_PICTURE = `s/${SET.id}/preview.jpg`;

describe('checkSite', () => {
  it.each([GITHUB, CLOUDFLARE])('passes a build for $name', async (host) => {
    const { options, pages, images } = await build(host);
    expect(pages).toHaveLength(20);
    expect(images).toContain(SET_PICTURE);
    expect(await checkSite(options)).toEqual({ pages: pages.length + 1, images: images.length + 1, errors: [] });
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
        { path: share, error: expect.stringMatching(/^Missing: the preview page for genesis\//) },
        { path: setPage, error: `Missing: the preview page for set ${SET.id}` },
      ]),
    );
    expect(errors).toHaveLength(2);
  });

  it('fails a build missing what its pages or stylesheets load', async () => {
    const { options, outDir } = await build(GITHUB);
    unlinkSync(`${outDir}assets/index.js`);
    unlinkSync(`${outDir}assets/paper.webp`);
    const { errors } = await checkSite(options);
    expect(errors).toEqual([
      { path: 'index.html', error: "Links to /BrainrotTCG/assets/index.js, which isn't in the build (assets/index.js)" },
      { path: 'assets/index.css', error: "Links to ./paper.webp, which isn't in the build (assets/paper.webp)" },
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
      expect(errors).toContainEqual({ path: `s/${SET.id}/index.html`, error: `og:url is ${other.site}s/${SET.id}/, not under SITE_URL ${built.site}` });
      expect(decoded).toBeLessThan(images.length);
    });

    it(`fails the whole build when checked as ${other.name}'s`, async () => {
      const { options } = await build(built);
      const { errors } = await checkSite({ ...options, base: other.base, site: other.site });
      expect(errors).toContainEqual({ path: 'index.html', error: expect.stringMatching(/^Links to .*assets\/index\.js/) });
      expect(errors).toContainEqual({ path: 'index.html', error: `og:image is ${built.site}og-image.jpg, not under SITE_URL ${other.site}` });
      expect(errors).toContainEqual({ path: `s/${SET.id}/index.html`, error: `Forwards to ${built.base}, not BASE_PATH ${other.base}` });
    });
  });
});
