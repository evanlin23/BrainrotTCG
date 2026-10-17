/**
 * Link previews for shared pulls (see src/game/previewLinks.ts): after `vite build`, writes into
 * dist/p/ a 1200x630 preview image and a tiny page for every hand each set's cards can make: the
 * cards that make it face up, the rest of the pack face down. Opening a page forwards to the pull
 * in its '#'. The one-card pages earlier Full House and Two Pair links went to are kept.
 *
 *   npx tsx scripts/preview-pages.ts        (part of `npm run build`)
 *
 * Drawing them all takes a couple of minutes, so they're kept between builds in .cache/previews/,
 * named by a hash of everything that decides them, and only new or changed ones are drawn. Part of
 * that hash is the cache contract (this script, sharp and the libraries it draws with, and
 * PREVIEW_CACHE_VERSION); CI keys its cache on it, so a cache drawn under another contract is never
 * restored:
 *
 *   npx tsx scripts/preview-pages.ts --cache-contract
 *
 * It also writes a page per released set at s/<set id>/ (with a picture of the set's rarest cards),
 * so a link to a set unfurls as that set. Like the pull pages, it forwards to the app, opening the
 * packs screen on that set (#/set/<set id>).
 *
 * SITE_URL (the site's absolute address, for the image) and BASE_PATH (its path) default to the
 * GitHub Pages address, like vite.config.ts. After a move, the deploy also writes the pages (without
 * images, OUT_DIR=<dir> PAGES_ONLY=1) for the old address, where they forward through its redirect
 * page, so old shared links keep their preview.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ALL_SET_VERSIONS, SETS } from '../src/content/sets/index.ts';
import { POKER_HANDS, RARITIES_RAREST_FIRST, type HandKey, type SetDefinition } from '../src/engine/index.ts';
import { cardPreviewPath, PREVIEW_COPIES, previewImagePath, previewPath, previewTitle, setPagePath, singleCardImagePath, type Preview } from '../src/game/previewLinks.ts';
import { setLinkHash } from '../src/game/route.ts';
import { isMainModule } from './main-module.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export interface PreviewOptions {
  /** Where the built site is, ending in '/'. */
  outDir: string;
  /** Pages only, no pictures: for the old address after a move. */
  pagesOnly: boolean;
  /** The site's path, as vite.config.ts serves it. */
  base: string;
  /** The site's absolute address, for the pictures. */
  site: string;
  /** Every set version (old versions' pulls still verify and still get shared). */
  versions?: readonly SetDefinition[];
  /** The latest version of each set, for the set pages. */
  sets?: readonly SetDefinition[];
}

export const optionsFromEnv = (env: NodeJS.ProcessEnv = process.env): PreviewOptions => {
  const base = env.BASE_PATH ?? '/BrainrotTCG/';
  return {
    outDir: env.OUT_DIR ? `${env.OUT_DIR.replace(/\/$/, '')}/` : `${ROOT}dist/`,
    pagesOnly: env.PAGES_ONLY === '1',
    base,
    // SITE_URL may end in / or not; the pages always name it ending in one.
    site: env.SITE_URL ? `${env.SITE_URL.replace(/\/+$/, '')}/` : `https://evanlin23.github.io${base}`,
  };
};
const W = 1200;
const H = 630;
const CARD_H = 500;
const CARD_W = Math.round((CARD_H * 687) / 1024);
const PACK_SIZE = 5;
// Five cards in an overlapping row, the first one fully covered by none.
const MARGIN = 60;
const STEP = Math.round((W - 2 * MARGIN - CARD_W) / (PACK_SIZE - 1));
// The one-card picture of the earlier pages.
const SINGLE_H = 580;
const SINGLE_W = Math.round((SINGLE_H * 687) / 1024);
const RARITY_NAMES: Record<string, string> = { COMMON: 'Common', UNCOMMON: 'Uncommon', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary', BRAINROT: 'Brainrot' };

export const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PageMeta {
  title: string;
  description: string;
  /** The picture's absolute address. */
  image: string;
  /** The page's own absolute address, for pages a link can point at as they are (not the pull pages, whose links carry the pull). */
  url?: string;
  /** Where in the app the page opens when its link carries no pull: a set's page opens on that set. */
  landing?: string;
}

/**
 * A tiny page with link-preview tags (as index.html has them) that forwards to the app at `base`,
 * keeping a pull in its '#', or else opening at `landing`.
 */
export const page = ({ title, description, image, url, landing = '' }: PageMeta, base: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Brainrot TCG</title>
<meta name="description" content="${escape(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Brainrot TCG">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
${url ? `<meta property="og:url" content="${escape(url)}">\n` : ''}<meta property="og:image" content="${escape(image)}">
<meta property="og:image:width" content="${W}">
<meta property="og:image:height" content="${H}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escape(title)}">
<meta name="twitter:description" content="${escape(description)}">
<meta name="twitter:image" content="${escape(image)}">
<meta name="theme-color" content="#121114">
<meta name="robots" content="noindex">
<script>location.replace(${JSON.stringify(base)} + (location.hash.indexOf('#/pull/') === 0 ? location.hash : ${JSON.stringify(landing)}));</script>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121114;color:#f2efe9;font:16px system-ui,sans-serif}a{color:#ffd23f}</style>
</head>
<body><a href="${escape(base + landing)}">Open Brainrot TCG</a></body>
</html>
`;

export interface SetStub {
  setId: string;
  /** The page, relative to the site's root. */
  path: string;
  /** Its address, relative to the site's root. */
  url: string;
  /** Where in the app it opens: the packs screen on this set. */
  landing: string;
  /** Its picture, relative to the site's root. */
  imagePath: string;
  title: string;
  description: string;
  /** The cards in the picture: the set's rarest, at most a pack's worth. */
  cardIds: string[];
}

/**
 * A page for each released set (drafts have none): s/<set id>/, showing its rarest cards. An
 * archived set keeps its page, so links already shared to it still load; the app opens on its
 * default set when the linked one can't be opened.
 */
export const setStubs = (sets: readonly SetDefinition[] = SETS): SetStub[] =>
  sets
    .filter((set) => !set.draft)
    .map((set) => ({
      setId: set.id,
      path: `${setPagePath(set.id)}index.html`,
      url: setPagePath(set.id),
      landing: setLinkHash(set.id),
      imagePath: `s/${set.id}/preview.jpg`,
      title: set.name,
      description: `${set.tagline ?? set.name} (${set.era}, ${set.cards.length} cards). Every pull is verifiable.`,
      cardIds: [...set.cards]
        .sort((a, b) => RARITIES_RAREST_FIRST.indexOf(a.rarity) - RARITIES_RAREST_FIRST.indexOf(b.rarity))
        .slice(0, PACK_SIZE)
        .map((card) => card.id),
    }));

// Binder black, like the app (docs/DESIGN.md): the card brings the colour.
const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#121114"/></svg>`);

/** Every hand a set's cards can make, by the cards that make it. */
const handsOf = (setId: string, ids: readonly string[]): Preview[] =>
  (Object.keys(POKER_HANDS) as HandKey[]).flatMap((hand): Preview[] => {
    if (hand === 'FULL_HOUSE') return ids.flatMap((a) => ids.filter((b) => b !== a).map((b) => ({ setId, cardIds: [a, b], hand })));
    if (hand === 'TWO_PAIR') return ids.flatMap((a, i) => ids.slice(i + 1).map((b) => ({ setId, cardIds: [a, b], hand })));
    return ids.map((a) => ({ setId, cardIds: [a], hand }));
  });

const art = (setId: string, cardId: string) => `${ROOT}src/content/sets/${setId}/cards/${cardId}.webp`;
const CARD_BACK = `${ROOT}src/assets/images/card_back.webp`;
const CACHE = `${ROOT}.cache/previews/`;
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Bump to redraw every cached picture when something outside this script and sharp changes how they look. */
export const PREVIEW_CACHE_VERSION = 1;

/** What every cached picture was drawn under: this script, sharp's own versions (libvips, mozjpeg, ...) and PREVIEW_CACHE_VERSION. */
export const previewCacheContract = (
  script: string | Buffer = readFileSync(fileURLToPath(import.meta.url)),
  versions: object = sharp.versions,
  version = PREVIEW_CACHE_VERSION,
) => sha(JSON.stringify([version, sha(script), versions]));
const rarityName = (rarity: string) => RARITY_NAMES[rarity] ?? rarity;
const SEE = 'Open the link to see the whole pack and re-check it on your own device.';

/** Writes the pages (and, unless pagesOnly, the pictures) into outDir. Returns each page's path, and what it shows. */
export const generatePreviews = async ({ outDir, pagesOnly, base, site, versions = ALL_SET_VERSIONS, sets: current = SETS }: PreviewOptions) => {
  // Each set's cards, across its versions: old versions' pulls still verify and still get shared.
  const sets = new Map<string, { name: string; cards: Map<string, { name: string; rarity: string }> }>();
  for (const set of versions) {
    const entry = sets.get(set.id) ?? { name: set.name, cards: new Map() };
    entry.name = set.name;
    for (const card of set.cards) entry.cards.set(card.id, { name: card.name, rarity: card.rarity });
    sets.set(set.id, entry);
  }

  const faces = new Map<string, Promise<Buffer>>();
  const face = (file: string) => {
    if (!faces.has(file)) faces.set(file, sharp(file).resize(CARD_W, CARD_H).png().toBuffer());
    return faces.get(file)!;
  };
  const CONTRACT = previewCacheContract();
  const fileHashes = new Map<string, string>();
  const fileHash = (file: string) => {
    if (!fileHashes.has(file)) fileHashes.set(file, sha(readFileSync(file)));
    return fileHashes.get(file)!;
  };
  const cacheUsed = new Set<string>();
  let drawn = 0;

  const writeImage = async (path: string, layers: { file: string; left: number; top: number; size?: [number, number] }[]) => {
    const name = `${sha([CONTRACT, ...layers.map((l) => `${fileHash(l.file)}@${l.left},${l.top},${l.size ?? ''}`)].join('|'))}.jpg`;
    cacheUsed.add(name);
    if (!existsSync(`${CACHE}${name}`)) {
      const inputs = await Promise.all(layers.map(async (l) => ({ input: l.size ? await sharp(l.file).resize(...l.size).toBuffer() : await face(l.file), left: l.left, top: l.top })));
      await sharp(background).composite(inputs).jpeg({ quality: 75, mozjpeg: true }).toFile(`${CACHE}${name}.tmp`);
      renameSync(`${CACHE}${name}.tmp`, `${CACHE}${name}`);
      drawn++;
    }
    mkdirSync(`${outDir}${path.replace(/[^/]+$/, '')}`, { recursive: true });
    copyFileSync(`${CACHE}${name}`, `${outDir}${path}`);
  };

  /** Five cards in a row: these face up, then card backs. */
  const rowImage = (path: string, faceUp: string[]) => {
    const files = [...faceUp];
    while (files.length < PACK_SIZE) files.push(CARD_BACK);
    return writeImage(path, files.map((file, i) => ({ file, left: MARGIN + i * STEP, top: Math.round((H - CARD_H) / 2) })));
  };

  /** The pack as five cards: each face-up card as many times as the hand has it, then card backs. */
  const packImage = (preview: Preview) =>
    rowImage(previewImagePath(preview), preview.cardIds.flatMap((id, i) => Array<string>(PREVIEW_COPIES[preview.hand][i]).fill(art(preview.setId, id))));

  const singleImage = (setId: string, cardId: string) =>
    writeImage(singleCardImagePath(setId, cardId), [
      { file: art(setId, cardId), left: Math.round((W - SINGLE_W) / 2), top: Math.round((H - SINGLE_H) / 2), size: [SINGLE_W, SINGLE_H] },
    ]);

  const written = new Map<string, string>();
  const writePage = (path: string, what: string, meta: PageMeta) => {
    if (written.has(path)) throw new Error(`Preview code collision: ${what} and ${written.get(path)} both map to ${path}`);
    written.set(path, what);
    mkdirSync(`${outDir}${path.replace(/[^/]+$/, '')}`, { recursive: true });
    writeFileSync(`${outDir}${path}`, page(meta, base));
  };

  const images: (() => Promise<void>)[] = [];
  for (const [setId, set] of sets) {
    const ids = [...set.cards.keys()].sort();
    for (const preview of handsOf(setId, ids)) {
      const cards = preview.cardIds.map((id) => set.cards.get(id)!);
      const description =
        preview.hand === 'NO_MATCH'
          ? `Best card: ${cards[0].name} (${rarityName(cards[0].rarity)}). ${SEE}`
          : `${cards.map((c, i) => `${PREVIEW_COPIES[preview.hand][i]}× ${c.name}`).join(' and ')}. ${SEE}`;
      writePage(previewPath(preview), `${setId}/${preview.cardIds.join('+')}/${preview.hand}`, { title: previewTitle(preview.hand, set.name), description, image: `${site}${previewImagePath(preview)}` });
      images.push(() => packImage(preview));
    }
    for (const [cardId, card] of set.cards) {
      const image = `${site}${singleCardImagePath(setId, cardId)}`;
      // A card shared on its own.
      writePage(cardPreviewPath(setId, cardId), `${setId}/${cardId}`, { title: `${card.name} from ${set.name}`, description: `${rarityName(card.rarity)}. Open the link to see the pack it came from and re-check it on your own device.`, image });
      // The one-card pages earlier Full House and Two Pair links point to (other hands' one-card
      // pages are the new ones, at the same address).
      for (const hand of ['FULL_HOUSE', 'TWO_PAIR'] as const) {
        writePage(previewPath({ setId, cardIds: [cardId], hand }), `${setId}/${cardId}/${hand}`, { title: previewTitle(hand, set.name), description: `${card.name} (${rarityName(card.rarity)}). ${SEE}`, image });
      }
      images.push(() => singleImage(setId, cardId));
    }
  }
  // A link to a set.
  for (const stub of setStubs(current)) {
    writePage(stub.path, `set ${stub.setId}`, { title: stub.title, description: stub.description, image: `${site}${stub.imagePath}`, url: `${site}${stub.url}`, landing: stub.landing });
    images.push(() => rowImage(stub.imagePath, stub.cardIds.map((id) => art(stub.setId, id))));
  }

  if (!pagesOnly) {
    mkdirSync(CACHE, { recursive: true });
    // A few at a time: each is quick, and sharp spreads one over the cores already.
    const queue = [...images];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await next();
    }));
    // Drop pictures nothing uses any more, so the cache doesn't grow forever.
    for (const name of readdirSync(CACHE)) if (!cacheUsed.has(name)) rmSync(`${CACHE}${name}`);
  }
  return { pages: written, images: pagesOnly ? 0 : images.length, drawn };
};

if (isMainModule(import.meta.url) && process.argv.includes('--cache-contract')) {
  console.log(previewCacheContract());
} else if (isMainModule(import.meta.url)) {
  const options = optionsFromEnv();
  const { pages, images, drawn } = await generatePreviews(options);
  console.log(`${options.pagesOnly ? 0 : `${images} (${drawn} drawn, the rest cached)`} preview images and ${pages.size} preview pages in ${options.outDir}p/ and s/ (images at ${options.site}, forwarding to ${options.base})`);
}
