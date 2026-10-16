/**
 * Checks a built site (`npm run build`) at the path and address it was built for, before it ships:
 *
 * - every page's local links (scripts, styles, icons, where a preview page forwards to) are under
 *   BASE_PATH and are in the build, and so is everything the stylesheets load;
 * - every page's link-preview tags point at SITE_URL, and the picture they name is in the build,
 *   decodes, and has the size its og:image:width/height tags say;
 * - every share and set page scripts/preview-pages.ts writes for the set registry is there and
 *   forwards to BASE_PATH.
 *
 *   npm run build && npm run check:site                      (GitHub Pages, /BrainrotTCG/)
 *   BASE_PATH=/ SITE_URL=https://brainrottcg.pages.dev/ npm run build    (Cloudflare Pages)
 *   BASE_PATH=/ SITE_URL=https://brainrottcg.pages.dev/ npm run check:site
 *
 * BASE_PATH, SITE_URL and OUT_DIR mean what they do for the build. It reads only the build and the
 * set registry: no network, and it never writes into the build.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAssets, type AssetCheck, type AssetValidationError } from './check-card-assets.ts';
import { isMainModule } from './main-module.ts';
import { generatePreviews, optionsFromEnv, type PreviewOptions } from './preview-pages.ts';

export type SiteCheckOptions = Pick<PreviewOptions, 'outDir' | 'base' | 'site' | 'versions' | 'sets'>;

export interface SiteCheckResult {
  /** HTML pages checked. */
  pages: number;
  /** Link-preview pictures decoded. */
  images: number;
  errors: AssetValidationError[];
}

const unescape = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A page's link-preview tags, by property or name. */
export const metaTags = (html: string): Map<string, string> =>
  new Map([...html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)].map((m) => [m[1], unescape(m[2])]));

/** Where a preview page forwards to (scripts/preview-pages.ts: location.replace(base + ...)). */
export const forwardTarget = (html: string): string | undefined => {
  const match = /location\.replace\(("(?:[^"\\]|\\.)*")/.exec(html);
  return match ? (JSON.parse(match[1]) as string) : undefined;
};

const IMAGE_FORMATS: Record<string, AssetCheck['format']> = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };

/** Every file under dir, relative to it with '/' separators. */
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));

/** The share and set pages scripts/preview-pages.ts writes for these sets, written aside and thrown away. */
const expectedPreviewPages = async ({ base, site, versions, sets }: SiteCheckOptions): Promise<Map<string, string>> => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-site-'));
  try {
    return (await generatePreviews({ outDir: `${dir}/`, pagesOnly: true, base, site, versions, sets })).pages;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const checkSite = async (options: SiteCheckOptions, concurrency = 8): Promise<SiteCheckResult> => {
  const { base, site } = options;
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
    const forward = forwardTarget(html);
    if (forward !== undefined) {
      if (forward !== base) fail(file, `Forwards to ${forward}, not BASE_PATH ${base}`);
      checkLink(file, forward);
    }

    const meta = metaTags(html);
    for (const key of ['og:url', 'og:image', 'twitter:image']) {
      const url = meta.get(key);
      if (url !== undefined && !url.startsWith(site)) fail(file, `${key} is ${url}, not under SITE_URL ${site}`);
    }
    const image = meta.get('og:image');
    if (!image?.startsWith(site)) continue;
    if (meta.get('twitter:image') !== image) fail(file, `twitter:image (${meta.get('twitter:image')}) isn't og:image (${image})`);
    const relative = image.slice(site.length).replace(/[?#].*$/, '');
    const format = IMAGE_FORMATS[path.extname(relative).toLowerCase()];
    if (!format) {
      fail(file, `og:image ${image} isn't a JPEG or WebP`);
      continue;
    }
    const width = Number(meta.get('og:image:width'));
    const height = Number(meta.get('og:image:height'));
    const dimensions = width > 0 && height > 0 ? { width, height } : undefined;
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
  const expected = await expectedPreviewPages(options);
  for (const [page, what] of expected) {
    if (!present.has(page)) fail(page, `Missing: the preview page for ${what}`);
  }

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
