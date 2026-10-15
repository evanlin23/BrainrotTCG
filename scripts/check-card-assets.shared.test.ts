import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { SetDefinition } from '../src/engine/types.ts';
import { checkRegisteredAssets, getRegisteredAssetChecks } from './check-card-assets.ts';

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const set = (version = 1, ids = ['card']): SetDefinition => ({
  id: 'test-set', version, cards: ids.map((id) => ({ id })),
} as SetDefinition);
const assetPath = (relative: string) => path.join(root, relative);
const write = (relative: string, bytes: string | Buffer) => {
  const file = assetPath(relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
};
const manifest = (entries: object) => write('src/content/sets/test-set/finish-thumbs/.manifest.json', JSON.stringify(entries));
const image = (width: number, height: number, alpha = false) => sharp({
  create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: alpha ? 0.5 : 1 } },
}).webp().toBuffer();

async function fixture() {
  root = mkdtempSync(path.join(os.tmpdir(), 'shared-assets-test-'));
  manifest({ card: 'generator-input-hash' });
  for (const asset of getRegisteredAssetChecks([set()], root)) {
    mkdirSync(path.dirname(asset.path), { recursive: true });
    // The back/base images have no fixed-pixel constraint; generated assets do.
    const { width, height } = asset.dimensions ?? { width: 100, height: 100 };
    writeFileSync(asset.path, await image(width, height, asset.alpha));
  }
}

describe('registered shared image contracts', () => {
  it('deduplicates set versions and includes opted-in retained cards, not hypothetical variants', () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'shared-assets-test-'));
    manifest({ old: 'hash', shared: 'hash', unregistered: 'hash' });
    const checks = getRegisteredAssetChecks([set(2, ['shared', 'optional']), set(1, ['old', 'shared'])], root);
    const paths = checks.map((check) => path.relative(root, check.path));
    expect(checks).toHaveLength(15); // Three base cards, two pack images, eight declared finishes, two shared images.
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('src/content/sets/test-set/finish-thumbs/old.gold.webp');
    expect(paths.some((file) => file.includes('finish-thumbs/optional.'))).toBe(false);
    expect(paths.some((file) => file.includes('unregistered.'))).toBe(false);
  });

  it('does not require absent archived/draft pack art and still validates retained art', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'shared-assets-test-'));
    const archived = { ...set(2), archivedAt: '2026-01-01' };
    const draft = { ...set(), id: 'draft', draft: true };
    const sets = [set(1), archived, draft];
    expect(getRegisteredAssetChecks(sets, root).filter((asset) => asset.path.includes('/pack'))).toEqual([]);
    write('src/content/sets/test-set/pack.webp', await image(768, 1376));
    const retained = getRegisteredAssetChecks(sets, root).filter((asset) => asset.path.endsWith('/pack.webp'));
    expect(retained).toHaveLength(1);
    expect(retained[0].dimensions).toEqual({ width: 768, height: 1376 });
  });

  it('fully decodes the registered base, pack, opted-in finish and shared images', async () => {
    await fixture();
    expect(await checkRegisteredAssets([set()], 2, root)).toEqual({ total: 9, errors: [] });
  });

  it.each([
    'src/content/sets/test-set/pack.webp',
    'src/content/sets/test-set/pack-thumb.webp',
    'src/content/sets/test-set/finish-thumbs/card.gold.webp',
    'src/assets/images/card_back.webp',
    'src/assets/images/card-frame-mask.webp',
  ])('reports a missing required asset: %s', async (file) => {
    await fixture();
    rmSync(assetPath(file));
    const result = await checkRegisteredAssets([set()], 2, root);
    expect(result.errors).toEqual([{ path: file, error: 'File does not exist' }]);
  });

  it('rejects a corrupt shared image even when its metadata decodes', async () => {
    await fixture();
    const file = 'src/assets/images/card_back.webp';
    const bytes = readFileSync(assetPath(file));
    bytes[33] ^= 255;
    write(file, bytes);
    expect((await sharp(assetPath(file)).metadata()).width).toBe(100);
    const result = await checkRegisteredAssets([set()], 2, root);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(file);
  });

  it.each([
    ['src/content/sets/test-set/pack.webp', 768, 1376],
    ['src/content/sets/test-set/pack-thumb.webp', 300, 533],
    ['src/content/sets/test-set/finish-thumbs/card.gold.webp', 344, 513],
    ['src/assets/images/card-frame-mask.webp', 687, 1024],
  ] as const)('rejects wrong generator geometry: %s', async (file, width, height) => {
    await fixture();
    write(file, await image(width - 1, height, true));
    const result = await checkRegisteredAssets([set()], 2, root);
    expect(result.errors).toEqual([{ path: file, error: `Expected ${width}x${height}, got ${width - 1}x${height}` }]);
  });

  it('requires alpha in the finish mask and WebP encoding in shared images', async () => {
    await fixture();
    write('src/assets/images/card-frame-mask.webp', await image(687, 1024));
    write('src/assets/images/card_back.webp', await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer());
    const result = await checkRegisteredAssets([set()], 2, root);
    expect(result.errors.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'src/assets/images/card_back.webp', error: 'Expected WebP, got png' },
      { path: 'src/assets/images/card-frame-mask.webp', error: 'Expected an alpha channel' },
    ].sort((a, b) => a.path.localeCompare(b.path)));
  });

  it('allows missing undeclared finishes but validates present fallback thumbnails without a manifest', async () => {
    await fixture();
    rmSync(assetPath('src/content/sets/test-set/finish-thumbs/.manifest.json'));
    rmSync(assetPath('src/content/sets/test-set/finish-thumbs/card.gold.webp'));
    expect(await checkRegisteredAssets([set()], 2, root)).toEqual({ total: 8, errors: [] });
    write('src/content/sets/test-set/finish-thumbs/card.silver.webp', await image(1, 1));
    expect((await checkRegisteredAssets([set()], 2, root)).errors).toEqual([{
      path: 'src/content/sets/test-set/finish-thumbs/card.silver.webp', error: 'Expected 344x513, got 1x1',
    }]);
  });

  it.each(['{', '[]', '{"card":false}'])('fails closed with the path for an invalid opt-in manifest: %s', async (contents) => {
    root = mkdtempSync(path.join(os.tmpdir(), 'shared-assets-test-'));
    write('src/content/sets/test-set/finish-thumbs/.manifest.json', contents);
    await expect(checkRegisteredAssets([set()], 2, root)).rejects.toThrow('src/content/sets/test-set/finish-thumbs/.manifest.json:');
  });
});
