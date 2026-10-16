/**
 * Decodes registered card and shared pack/finish/frame WebP assets.
 * Checks generator geometry where the renderer defines it; never regenerates assets.
 *
 *   npx tsx scripts/check-card-assets.ts
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ALL_SET_VERSIONS, isOpenable } from '../src/content/sets/index.ts';
import type { SetDefinition } from '../src/engine/index.ts';
import { FINISHES_RAREST_FIRST } from '../src/engine/types.ts';
import frameLayout from './cards/templates/genesis-frame.json';
import { isMainModule } from './main-module.ts';

export const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

export interface AssetValidationError {
  path: string;
  error: string;
}

export interface CheckAssetsResult {
  total: number;
  errors: AssetValidationError[];
}

export interface AssetCheck {
  path: string;
  dimensions?: { width: number; height: number };
  alpha?: boolean;
  /** WebP unless given (scripts/check-site.ts checks the JPEG link-preview pictures). */
  format?: 'webp' | 'jpeg';
}

const FORMAT_NAMES = { webp: 'WebP', jpeg: 'JPEG' } as const;

// scripts/cards/pack.ts renders 768x1376; its 696x1236 picker crop resizes to 300x533.
const PACK_DIMENSIONS = { width: 768, height: 1376 };
const PACK_THUMB_DIMENSIONS = { width: 300, height: 533 };
// scripts/cards/finish-thumbs.ts resizes the shared frame to a width of 344.
const FINISH_THUMB_DIMENSIONS = { width: 344, height: Math.round(frameLayout.height * 344 / frameLayout.width) };

/**
 * Extract unique, deduplicated card WebP paths (relative or absolute) for all sets.
 */
export const getCardAssetPaths = (sets: SetDefinition[], rootDir = ROOT): string[] => {
  const pathSet = new Set<string>();
  for (const set of sets) {
    for (const card of set.cards) {
      const relPath = path.join('src', 'content', 'sets', set.id, 'cards', `${card.id}.webp`);
      const absPath = path.resolve(rootDir, relPath);
      pathSet.add(absPath);
    }
  }
  return Array.from(pathSet);
};

/** Registry references, with finish output opted in by the existing generator manifest. */
export const getRegisteredAssetChecks = (sets: SetDefinition[], rootDir = ROOT): AssetCheck[] => {
  const assets: AssetCheck[] = getCardAssetPaths(sets, rootDir).map((filePath) => ({ path: filePath }));
  const latest = new Map<string, SetDefinition>();
  const cardIds = new Map<string, Set<string>>();
  for (const set of sets) {
    if (!latest.has(set.id) || latest.get(set.id)!.version < set.version) latest.set(set.id, set);
    const ids = cardIds.get(set.id) ?? new Set<string>();
    for (const card of set.cards) ids.add(card.id);
    cardIds.set(set.id, ids);
  }

  for (const set of latest.values()) {
    const dir = path.resolve(rootDir, 'src/content/sets', set.id);
    for (const [file, dimensions] of [['pack.webp', PACK_DIMENSIONS], ['pack-thumb.webp', PACK_THUMB_DIMENSIONS]] as const) {
      const filePath = path.join(dir, file);
      // Match check:sets' required openable art; still validate retained archived/draft art.
      if (isOpenable(set) || existsSync(filePath)) assets.push({ path: filePath, dimensions });
    }

    const manifestPath = path.join(dir, 'finish-thumbs/.manifest.json');
    let manifest: object = {};
    if (existsSync(manifestPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          Object.values(parsed).some((hash) => typeof hash !== 'string')) throw new Error('Expected a card-to-hash object');
        manifest = parsed;
      } catch (error) {
        throw new Error(`${path.relative(rootDir, manifestPath)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // The generator emits these finishes for each opted-in card, including retained old versions.
    // Without an entry, absent variants may use the production full-resolution fallback;
    // present variants are still referenced by content/art.ts and must decode correctly.
    for (const id of cardIds.get(set.id)!) {
      for (const finish of FINISHES_RAREST_FIRST) {
        const filePath = path.join(dir, 'finish-thumbs', `${id}.${finish.toLowerCase()}.webp`);
        if (Object.hasOwn(manifest, id) || existsSync(filePath)) assets.push({ path: filePath, dimensions: FINISH_THUMB_DIMENSIONS });
      }
    }
  }

  // The back is scaled/cropped in the UI; only the pixel-aligned finish mask needs exact geometry.
  assets.push({ path: path.resolve(rootDir, 'src/assets/images/card_back.webp') });
  assets.push({ path: path.resolve(rootDir, 'src/assets/images/card-frame-mask.webp'), dimensions: frameLayout, alpha: true });
  return assets;
};

/**
 * Validates a single WebP asset file:
 * existence, non-empty content, positive dimensions, and full decoding.
 */
export const validateCardAsset = async (filePath: string, expected?: Omit<AssetCheck, 'path'>): Promise<{ valid: true } | { valid: false; error: string }> => {
  if (!existsSync(filePath)) {
    return { valid: false, error: 'File does not exist' };
  }

  try {
    const stat = statSync(filePath);
    if (stat.size === 0) {
      return { valid: false, error: 'File is empty (0 bytes)' };
    }

    // Inspect/decode one byte snapshot; libvips' filename cache must not hide changed files.
    const image = sharp(readFileSync(filePath));
    const meta = await image.metadata();
    const format = expected?.format ?? 'webp';
    if (meta.format !== format) return { valid: false, error: `Expected ${FORMAT_NAMES[format]}, got ${meta.format ?? 'unknown format'}` };
    if (!meta.width || !meta.height || meta.width <= 0 || meta.height <= 0) {
      return { valid: false, error: `Invalid or non-positive dimensions (${meta.width ?? 0}x${meta.height ?? 0})` };
    }
    if (expected?.dimensions && (meta.width !== expected.dimensions.width || meta.height !== expected.dimensions.height)) {
      return { valid: false, error: `Expected ${expected.dimensions.width}x${expected.dimensions.height}, got ${meta.width}x${meta.height}` };
    }
    if (expected?.alpha && !meta.hasAlpha) return { valid: false, error: 'Expected an alpha channel' };

    // Fully decode the image data to ensure no truncation or pixel corruption.
    await image.raw().toBuffer();
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Validates assets with bounded concurrency; error paths are relative to rootDir.
 */
export const checkAssets = async (
  assets: AssetCheck[],
  concurrency: number,
  rootDir: string,
): Promise<CheckAssetsResult> => {
  const errors: AssetValidationError[] = [];

  const limit = Math.max(1, concurrency);
  let index = 0;

  const worker = async () => {
    while (index < assets.length) {
      const asset = assets[index++];
      const res = await validateCardAsset(asset.path, asset);
      if (!res.valid) {
        errors.push({ path: path.relative(rootDir, asset.path), error: res.error });
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, assets.length) }, () => worker());
  await Promise.all(workers);

  return { total: assets.length, errors };
};

/** Base-card-only API retained for focused callers; the CLI checks the full registered scope. */
export const checkCardAssets = (sets: SetDefinition[] = ALL_SET_VERSIONS, concurrency = 8, rootDir = ROOT): Promise<CheckAssetsResult> =>
  checkAssets(getCardAssetPaths(sets, rootDir).map((filePath) => ({ path: filePath })), concurrency, rootDir);

export const checkRegisteredAssets = async (sets: SetDefinition[] = ALL_SET_VERSIONS, concurrency = 8, rootDir = ROOT): Promise<CheckAssetsResult> =>
  checkAssets(getRegisteredAssetChecks(sets, rootDir), concurrency, rootDir);

if (isMainModule(import.meta.url)) {
  checkRegisteredAssets(ALL_SET_VERSIONS)
    .then(({ total, errors }) => {
      if (errors.length > 0) {
        console.error(errors.map((e) => `✗ ${e.path}: ${e.error}`).join('\n'));
        process.exit(1);
      } else {
        console.log(`✓ ${total} registered card/shared WebP asset(s) OK`);
      }
    })
    .catch((err) => {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
