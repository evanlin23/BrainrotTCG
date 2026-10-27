/**
 * Checks a built site (`npm run build`) at the path and address it was built for, before it ships:
 *
 * - every page's local links (scripts, styles, icons, where a preview page forwards to) are under
 *   BASE_PATH and are in the build, and so is everything the stylesheets load;
 * - every page's link-preview tags point at SITE_URL (og:url, when a page has one, at that page's
 *   own address), and the picture they name is in the build, decodes as a JPEG, and has the size
 *   its og:image:width/height tags give (both are required);
 * - every page has og:title, og:image, twitter:image and a summary_large_image twitter:card, and
 *   index.html has og:url;
 * - robots.txt and sitemap.xml are real (not the app's page) and name SITE_URL, and the sitemap lists
 *   the app and no share, set or #/ address (scripts/crawler-files.ts);
 * - every share and set page scripts/preview-pages.ts writes for the set registry is there and
 *   forwards to BASE_PATH (a set's page to #/set/<set id> there);
 * - the cache contract (docs/HOSTING.md): everything in assets/ has a content hash in its name, pages
 *   load their code and styles from there, every other file sits at the top or in p/ or s/, and a
 *   _headers file, if there is one, marks only assets/ immutable;
 * - the build has at most MAX_SITE_FILES files (Cloudflare Pages takes 20,000 per deploy);
 * - the code and styles index.html loads before the app can first render come to at most
 *   MAX_FIRST_LOAD_BYTES gzipped (#776).
 *
 *   npm run build && npm run check:site                      (no env: under /BrainrotTCG/, as GitHub Pages serves it)
 *   BASE_PATH=/ SITE_URL=https://brainrottcg.pages.dev/ npm run build    (Cloudflare Pages)
 *   BASE_PATH=/ SITE_URL=https://brainrottcg.pages.dev/ npm run check:site
 *
 * BASE_PATH, SITE_URL and OUT_DIR mean what they do for the build (SITE_URL with or without its
 * trailing /). It reads only the build and the
 * set registry: no network, and it never writes into the build.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { checkAssets, type AssetCheck, type AssetValidationError } from './check-card-assets.ts';
import { isMainModule } from './main-module.ts';
import { generatePreviews, optionsFromEnv, type PreviewOptions } from './preview-pages.ts';
import { setLinkHash } from '../src/game/route.ts';

export type SiteCheckOptions = Pick<PreviewOptions, 'outDir' | 'base' | 'site' | 'versions' | 'sets'>;

export interface SiteCheckResult {
  /** HTML pages checked. */
  pages: number;
  /** Link-preview pictures decoded. */
  images: number;
  errors: AssetValidationError[];
}

/** The repository, whose src/ and public/ a build is made from. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));

const unescape = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A page's link-preview tags, by property or name, whatever order each tag's attributes are in. */
export const metaTags = (html: string): Map<string, string> => {
  const tags = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attributes = new Map([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1].toLowerCase(), unescape(m[2] ?? m[3])]));
    const key = attributes.get('property') ?? attributes.get('name');
    const content = attributes.get('content');
    if (key !== undefined && content !== undefined) tags.set(key, content);
  }
  return tags;
};

/** Where a page in the build is served: a directory's index.html at the directory. */
export const pageUrl = (site: string, file: string): string =>
  file === 'index.html' ? site : file.endsWith('/index.html') ? `${site}${file.slice(0, -'index.html'.length)}` : `${site}${file}`;

/** Where a preview page forwards to (scripts/preview-pages.ts: location.replace(base + ...)). */
export const forwardTarget = (html: string): string | undefined => {
  const match = /location\.replace\(("(?:[^"\\]|\\.)*")/.exec(html);
  return match ? (JSON.parse(match[1]) as string) : undefined;
};

/** Where in the app a preview page opens when its link carries no pull ('' for Open). */
export const forwardLanding = (html: string): string => {
  const match = /location\.replace\(.*: ("(?:[^"\\]|\\.)*")\)\);/.exec(html);
  return match ? (JSON.parse(match[1]) as string) : '';
};

/** Where a page in the build should open in the app: a set's page (s/<set id>/) on that set. */
const expectedLanding = (file: string): string => {
  const set = /^s\/([^/]+)\/index\.html$/.exec(file);
  return set ? setLinkHash(set[1]) : '';
};

/** Every file under dir, relative to it with '/' separators. */
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));

/**
 * The cache contract (docs/HOSTING.md): Vite names everything in assets/ by a hash of its content,
 * so a host may keep those forever; everything else keeps its name between deploys and must
 * revalidate. A file that keeps its name can only be at the top (public/ and index.html) or in the
 * preview pages' p/ and s/.
 *
 * Vite's names are `<source name>-<8 base64url characters>.<ext>`. The shape alone can't tell a hash
 * from a word (`finish-rainbows.webp`), and a hash can be all lowercase letters too, so a name in
 * assets/ that is also a source file's name (in src/ or public/) is one copied there as it was.
 * A sourcemap, if a build emits one, is named after its file plus `.map`, so it's hashed too.
 */
export const HASHED_ASSET = /^assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+(?:\.map)?$/;
const REVALIDATED = /^(?:[^/]+|[ps]\/.+|api\/.+)$/;
/** The longest a file that keeps its name may be cached without revalidating: a day. */
export const MAX_REVALIDATED_AGE = 86400;

/** The names of the files a build is made from (in src/ and public/), which no hashed name can be. */
export const sourceNames = (root = ROOT): Set<string> =>
  new Set(['src', 'public'].flatMap((dir) => (existsSync(path.join(root, dir)) ? filesIn(path.join(root, dir)).map((file) => path.posix.basename(file)) : [])));

/**
 * Problems with a build's file names, and its _headers file if it has one, against the cache contract.
 * `sources` holds the names of the files the build is made from (see sourceNames).
 */
export const checkCacheContract = (files: readonly string[], base: string, headers?: string, sources: ReadonlySet<string> = new Set()): AssetValidationError[] => {
  const errors: AssetValidationError[] = [];
  for (const file of files) {
    if (file === '_headers') continue;
    if (file.startsWith('assets/')) {
      if (!HASHED_ASSET.test(file) || sources.has(path.posix.basename(file).replace(/\.map$/, ''))) errors.push({ path: file, error: "Has no content hash in its name, but assets/ is cached as if it never changes" });
    } else if (!REVALIDATED.test(file)) {
      errors.push({ path: file, error: 'Keeps its name between deploys outside the top level, p/, s/ and api/ (the cache contract in docs/HOSTING.md)' });
    }
  }
  if (headers === undefined) return errors;
  // Netlify/Cloudflare Pages _headers: a path line, then indented "Name: value" lines.
  let rule = '';
  let assetsImmutable = false;
  for (const line of headers.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      rule = line.trim();
      continue;
    }
    const [name, ...rest] = line.trim().split(':');
    if (name.trim().toLowerCase() !== 'cache-control') continue;
    const value = rest.join(':');
    const immutable = /\bimmutable\b/i.test(value);
    if (rule === `${base}assets/*`) {
      if (immutable) assetsImmutable = true;
      continue;
    }
    if (rule.startsWith(`${base}assets/`)) continue;
    if (immutable) errors.push({ path: '_headers', error: `Marks ${rule} immutable; only ${base}assets/* is hashed` });
    const age = Math.max(-1, ...[...value.matchAll(/\b(?:max-age|s-maxage)\s*=\s*(\d+)/gi)].map((m) => Number(m[1])));
    if (age > MAX_REVALIDATED_AGE) errors.push({ path: '_headers', error: `Caches ${rule} for ${age}s; only ${base}assets/* is hashed, so the rest must revalidate within ${MAX_REVALIDATED_AGE}s` });
  }
  if (!assetsImmutable) errors.push({ path: '_headers', error: `Doesn't mark ${base}assets/* immutable` });
  return errors;
};

/**
 * Problems with a build's robots.txt and sitemap.xml (undefined when missing) for `site`, ending in
 * one /. A host with no such file answers with the app's own page, which is no robots.txt or sitemap.
 */
export const checkCrawlerFiles = (site: string, robots: string | undefined, sitemap: string | undefined): AssetValidationError[] => {
  const errors: AssetValidationError[] = [];
  const html = /^\s*<(?:!doctype|html)\b/i;
  if (robots === undefined || html.test(robots)) errors.push({ path: 'robots.txt', error: robots === undefined ? 'Missing' : 'Is an HTML page' });
  else {
    if (!robots.split(/\r?\n/).some((line) => line.trim() === `Sitemap: ${site}sitemap.xml`)) errors.push({ path: 'robots.txt', error: `Doesn't name the sitemap at ${site}sitemap.xml` });
    if (robots.split(/\r?\n/).some((line) => /^disallow:\s*\/\s*$/i.test(line.trim()))) errors.push({ path: 'robots.txt', error: 'Blocks the whole site' });
  }
  if (sitemap === undefined || !/^<\?xml\b/.test(sitemap) || !/<urlset\b[^>]*xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/.test(sitemap)) {
    errors.push({ path: 'sitemap.xml', error: sitemap === undefined ? 'Missing' : "Isn't a sitemap (an XML urlset)" });
    return errors;
  }
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => unescape(m[1]));
  if (!locs.includes(site)) errors.push({ path: 'sitemap.xml', error: `Doesn't list the app at ${site}` });
  for (const loc of locs) {
    if (!loc.startsWith(site)) errors.push({ path: 'sitemap.xml', error: `Lists ${loc}, not under SITE_URL ${site}` });
    else if (/#|^[ps]\//.test(loc.slice(site.length))) errors.push({ path: 'sitemap.xml', error: `Lists ${loc}, a share, set or in-app address` });
  }
  return errors;
};

// The build draws every link-preview picture as a JPEG (scripts/preview-pages.ts, public/og-image.jpg).
const IMAGE_FORMATS: Record<string, AssetCheck['format']> = { '.jpg': 'jpeg', '.jpeg': 'jpeg' };

/** The share and set pages scripts/preview-pages.ts writes for these sets, written aside and thrown away. */
const expectedPreviewPages = async ({ base, site, versions, sets }: SiteCheckOptions): Promise<Map<string, string>> => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-site-'));
  try {
    return (await generatePreviews({ outDir: `${dir}/`, pagesOnly: true, base, site, versions, sets })).pages;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Most files a build may have: Cloudflare Pages takes 20,000 per deploy, and this leaves room. */
export const MAX_SITE_FILES = 19_000;

export const checkFileCount = (count: number, max = MAX_SITE_FILES): AssetValidationError[] =>
  count > max ? [{ path: '.', error: `Has ${count.toLocaleString('en-US')} files, over ${max.toLocaleString('en-US')} (Cloudflare Pages takes 20,000 per deploy)` }] : [];

/**
 * Most bytes, gzipped as the hosts serve them, of index.html and the code and styles it loads before
 * the app can first render (#776: on a slow connection these come before anything else). Raise it
 * only with a reason in the PR: what was added, and why the first screen can't load it later.
 */
export const MAX_FIRST_LOAD_BYTES = 280_000;

/** The files (relative to the build) index.html loads up front: its module scripts, modulepreloads and stylesheets. */
export const firstLoadFiles = (html: string, base: string): string[] =>
  [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"[^>]*>|<link\b(?=[^>]*\brel="(?:stylesheet|modulepreload)")[^>]*\bhref="([^"]*)"[^>]*>/g)]
    .map(([, src, href]) => unescape(src ?? href))
    .filter((link) => link.startsWith(base))
    .map((link) => link.slice(base.length).replace(/[?#].*$/, ''));

export const checkFirstLoad = (bytes: number, max = MAX_FIRST_LOAD_BYTES): AssetValidationError[] =>
  bytes > max ? [{ path: 'index.html', error: `Loads ${bytes.toLocaleString('en-US')} bytes (gzip) before the app can render, over ${max.toLocaleString('en-US')} (MAX_FIRST_LOAD_BYTES, #776)` }] : [];

export const checkSite = async (options: SiteCheckOptions, concurrency = 8): Promise<SiteCheckResult> => {
  const { base } = options;
  // SITE_URL may end in / or not: compare against it ending in exactly one, as the build writes it.
  const site = `${options.site.replace(/\/+$/, '')}/`;
  const outDir = path.resolve(options.outDir);
  const errors: AssetValidationError[] = [];
  const fail = (file: string, error: string) => {
    errors.push({ path: file, error });
  };
  if (!existsSync(path.join(outDir, 'index.html'))) {
    fail('index.html', `Missing: is ${outDir} a build (npm run build)?`);
    return { pages: 0, images: 0, errors };
  }
  const files = filesIn(outDir);
  errors.push(...checkFileCount(files.length));
  const present = new Set(files);

  /** A link from `from` (relative to the build) to the site's own files must stay under base and land on a file. */
  const checkLink = (from: string, link: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link)) return; // another site, data: or a fragment
    const bare = link.replace(/[?#].*$/, '');
    let target: string;
    if (bare.startsWith('/')) {
      if (!bare.startsWith(base)) {
        fail(from, `Links to ${link}, outside BASE_PATH ${base}`);
        return;
      }
      target = bare.slice(base.length);
    } else {
      target = path.posix.join(path.posix.dirname(from), bare);
    }
    target = target.replace(/^\.\//, '');
    if (target === '' || target === '.') target = 'index.html';
    else if (target.endsWith('/')) target = `${target}index.html`;
    if (!present.has(target)) fail(from, `Links to ${link}, which isn't in the build (${target})`);
  };

  const images = new Map<string, AssetCheck>();
  const htmlPages = files.filter((file) => file.endsWith('.html'));
  for (const file of htmlPages) {
    const html = readFileSync(path.join(outDir, file), 'utf8');
    for (const [, link] of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) checkLink(file, unescape(link));
    // The page's own code and styles are hashed (the cache contract), and so come from this site's
    // assets/: not another site, which this build can't hash, nor a relative path, which breaks
    // under p/ and s/.
    for (const [, tag] of html.matchAll(/(<script\b[^>]*\bsrc="[^"]*"[^>]*>|<link\b[^>]*\brel="(?:stylesheet|modulepreload)"[^>]*>)/g)) {
      const link = unescape(/\b(?:src|href)="([^"]*)"/.exec(tag)?.[1] ?? '');
      if (!link.startsWith(`${base}assets/`)) fail(file, `Loads ${link}, outside ${base}assets/, so it isn't hashed`);
    }
    const forward = forwardTarget(html);
    if (forward !== undefined) {
      if (forward !== base) fail(file, `Forwards to ${forward}, not BASE_PATH ${base}`);
      const landing = forwardLanding(html);
      if (landing !== expectedLanding(file)) fail(file, `Opens the app at '${landing}', not '${expectedLanding(file)}'`);
      checkLink(file, forward + landing);
    }

    const meta = metaTags(html);
    // Every page is one a link can point at, so every page previews as a large picture.
    for (const key of ['og:title', 'og:image', 'twitter:image']) if (!meta.get(key)) fail(file, `Has no ${key}`);
    if (meta.get('twitter:card') !== 'summary_large_image') fail(file, `twitter:card is ${meta.get('twitter:card') ?? 'missing'}, not summary_large_image`);
    const url = meta.get('og:url');
    if (file === 'index.html' && url === undefined) fail(file, 'Has no og:url');
    if (url !== undefined && url !== pageUrl(site, file)) fail(file, `og:url is ${url}, not ${pageUrl(site, file)}`);
    for (const key of ['og:image', 'twitter:image']) {
      const url = meta.get(key);
      if (url !== undefined && !url.startsWith(site)) fail(file, `${key} is ${url}, not under SITE_URL ${site}`);
    }
    const image = meta.get('og:image');
    if (!image?.startsWith(site)) continue;
    if (meta.get('twitter:image') !== image) fail(file, `twitter:image (${meta.get('twitter:image')}) isn't og:image (${image})`);
    const relative = image.slice(site.length).replace(/[?#].*$/, '');
    const format = IMAGE_FORMATS[path.extname(relative).toLowerCase()];
    if (!format) {
      fail(file, `og:image ${image} isn't a JPEG`);
      continue;
    }
    const width = Number(meta.get('og:image:width'));
    const height = Number(meta.get('og:image:height'));
    if (![width, height].every((n) => Number.isInteger(n) && n > 0)) {
      fail(file, `og:image ${relative} needs og:image:width and og:image:height (has ${meta.get('og:image:width') ?? 'none'} and ${meta.get('og:image:height') ?? 'none'})`);
      continue;
    }
    const dimensions = { width, height };
    const check = images.get(relative);
    if (check && JSON.stringify(check.dimensions) !== JSON.stringify(dimensions)) fail(file, `og:image ${relative} is given two different sizes`);
    if (!check) images.set(relative, { path: path.join(outDir, relative), format, dimensions });
  }

  // What the stylesheets load (fonts, images), relative to the stylesheet or under base.
  for (const file of files.filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(path.join(outDir, file), 'utf8');
    for (const [, , link] of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) checkLink(file, link.trim());
  }

  // Every page the set registry gets, as scripts/preview-pages.ts names them.
  const expected = await expectedPreviewPages({ ...options, site });
  for (const [page, what] of expected) {
    if (!present.has(page)) fail(page, `Missing: the preview page for ${what}`);
  }

  const optional = (file: string) => (present.has(file) ? readFileSync(path.join(outDir, file), 'utf8') : undefined);
  errors.push(...checkCrawlerFiles(site, optional('robots.txt'), optional('sitemap.xml')));

  const index = readFileSync(path.join(outDir, 'index.html'));
  const upFront = firstLoadFiles(index.toString('utf8'), base).filter((file) => present.has(file));
  errors.push(...checkFirstLoad(upFront.reduce((sum, file) => sum + gzipSync(readFileSync(path.join(outDir, file))).length, gzipSync(index).length)));

  const headersFile = path.join(outDir, '_headers');
  errors.push(...checkCacheContract(files, base, existsSync(headersFile) ? readFileSync(headersFile, 'utf8') : undefined, sourceNames()));

  const decoded = await checkAssets([...images.values()], concurrency, outDir);
  errors.push(...decoded.errors.map(({ path: file, error }) => ({ path: file.split(path.sep).join('/'), error })));
  return { pages: htmlPages.length, images: decoded.total, errors };
};

if (isMainModule(import.meta.url)) {
  const { outDir, base, site } = optionsFromEnv();
  const where = `${outDir} (BASE_PATH=${base} SITE_URL=${site})`;
  const started = Date.now();
  const { pages, images, errors } = await checkSite({ outDir, base, site });
  if (errors.length) {
    const SHOWN = 50;
    console.error(errors.slice(0, SHOWN).map((e) => `✗ ${e.path}: ${e.error}`).join('\n'));
    if (errors.length > SHOWN) console.error(`… and ${errors.length - SHOWN} more`);
    console.error(`✗ ${errors.length} problem(s) in ${where}`);
    process.exit(1);
  }
  console.log(`✓ ${pages} pages and ${images} preview images in ${where} OK in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
