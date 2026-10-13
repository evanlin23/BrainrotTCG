/**
 * Verifies base card WebP assets referenced by the set registry.
 * Ensures existence, non-empty size, valid dimensions, and complete WebP decoding.
 *
 *   npx tsx scripts/check-card-assets.ts
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ALL_SET_VERSIONS } from '../src/content/sets/index.ts';
import type { SetDefinition } from '../src/engine/index.ts';

export const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

export interface AssetValidationError {
  path: string;
  error: string;
}

export interface CheckAssetsResult {
  total: number;
  errors: AssetValidationError[];
}

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

/**
 * Validates a single WebP asset file:
 * existence, non-empty content, positive dimensions, and full decoding.
 */
export const validateCardAsset = async (filePath: string): Promise<{ valid: true } | { valid: false; error: string }> => {
  if (!existsSync(filePath)) {
    return { valid: false, error: 'File does not exist' };
  }

  try {
    const stat = statSync(filePath);
    if (stat.size === 0) {
      return { valid: false, error: 'File is empty (0 bytes)' };
    }

    const image = sharp(filePath);
    const meta = await image.metadata();
    if (!meta.width || !meta.height || meta.width <= 0 || meta.height <= 0) {
      return { valid: false, error: `Invalid or non-positive dimensions (${meta.width ?? 0}x${meta.height ?? 0})` };
    }

    // Fully decode the image data to ensure no truncation or pixel corruption.
    await image.raw().toBuffer();
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Validates card assets for the provided sets with bounded concurrency.
 */
export const checkCardAssets = async (
  sets: SetDefinition[] = ALL_SET_VERSIONS,
  concurrency = 8,
  rootDir = ROOT,
): Promise<CheckAssetsResult> => {
  const assetPaths = getCardAssetPaths(sets, rootDir);
  const errors: AssetValidationError[] = [];

  const limit = Math.max(1, concurrency);
  let index = 0;

  const worker = async () => {
    while (index < assetPaths.length) {
      const currentPath = assetPaths[index++];
      const res = await validateCardAsset(currentPath);
      if (!res.valid) {
        errors.push({ path: path.relative(rootDir, currentPath), error: res.error });
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, assetPaths.length) }, () => worker());
  await Promise.all(workers);

  return { total: assetPaths.length, errors };
};

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  checkCardAssets(ALL_SET_VERSIONS)
    .then(({ total, errors }) => {
      if (errors.length > 0) {
        console.error(errors.map((e) => `✗ ${e.path}: ${e.error}`).join('\n'));
        process.exit(1);
      } else {
        console.log(`✓ ${total} card WebP asset(s) OK`);
      }
    })
    .catch((err) => {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
