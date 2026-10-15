import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SetDefinition } from '../src/engine/index.ts';
import { checkCardAssets, getCardAssetPaths, validateCardAsset } from './check-card-assets.ts';

describe('check-card-assets', () => {
  let tmpDir: string;
  let validPath: string;
  let missingPath: string;
  let emptyPath: string;
  let corruptPath: string;
  let corruptPayloadPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'card-assets-test-'));

    validPath = path.join(tmpDir, 'valid.webp');
    const validWebpBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .webp()
      .toBuffer();
    writeFileSync(validPath, validWebpBuffer);

    missingPath = path.join(tmpDir, 'missing.webp');

    emptyPath = path.join(tmpDir, 'empty.webp');
    writeFileSync(emptyPath, Buffer.alloc(0));

    corruptPath = path.join(tmpDir, 'corrupt.webp');
    writeFileSync(corruptPath, Buffer.from('RIFF1234WEBPVP8 corrupt_payload_data'));

    corruptPayloadPath = path.join(tmpDir, 'corrupt-payload.webp');
    const validBuf = Buffer.from(validWebpBuffer);
    // Mutate pixel payload byte after header so metadata succeeds but full decode fails
    validBuf[33] ^= 255;
    writeFileSync(corruptPayloadPath, validBuf);
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates a valid WebP image successfully', async () => {
    const res = await validateCardAsset(validPath);
    expect(res).toEqual({ valid: true });
  });

  it('detects missing files', async () => {
    const res = await validateCardAsset(missingPath);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toMatch(/does not exist/i);
    }
  });

  it('detects empty (0-byte) files', async () => {
    const res = await validateCardAsset(emptyPath);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toMatch(/empty/i);
    }
  });

  it('detects corrupt WebP files with malformed headers during decoding', async () => {
    const res = await validateCardAsset(corruptPath);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toBeDefined();
      expect(typeof res.error).toBe('string');
    }
  });

  it('detects WebP files with valid metadata headers but corrupt pixel payload', async () => {
    // Assert sharp metadata succeeds first (header is valid)
    const meta = await sharp(corruptPayloadPath).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);

    // Assert full decoder validation fails due to pixel payload corruption
    const res = await validateCardAsset(corruptPayloadPath);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toBeDefined();
      expect(typeof res.error).toBe('string');
    }
  });

  it('deduplicates paths across sets and versions and processes all set cards', async () => {
    const mockSetDir = path.join(tmpDir, 'src', 'content', 'sets', 'test-set', 'cards');
    mkdirSync(mockSetDir, { recursive: true });

    // Copy/create fixtures in mock set structure
    const validCardPath = path.join(mockSetDir, 'card-valid.webp');
    const emptyCardPath = path.join(mockSetDir, 'card-empty.webp');
    const corruptCardPath = path.join(mockSetDir, 'card-corrupt.webp');

    const validBuf = await sharp({
      create: { width: 50, height: 50, channels: 4, background: '#00ff00' },
    })
      .webp()
      .toBuffer();
    writeFileSync(validCardPath, validBuf);
    writeFileSync(emptyCardPath, Buffer.alloc(0));
    writeFileSync(corruptCardPath, Buffer.from('RIFF_CORRUPT_DATA'));

    const mockSet1 = {
      id: 'test-set',
      version: 1,
      cards: [{ id: 'card-valid' }, { id: 'card-empty' }, { id: 'card-missing' }],
    } as unknown as SetDefinition;

    // Version 2 has duplicated card references + a corrupt card
    const mockSet2 = {
      id: 'test-set',
      version: 2,
      cards: [{ id: 'card-valid' }, { id: 'card-corrupt' }],
    } as unknown as SetDefinition;

    const sets = [mockSet1, mockSet2];

    const deduplicatedPaths = getCardAssetPaths(sets, tmpDir);
    // Unique card IDs across both sets: card-valid, card-empty, card-missing, card-corrupt = 4
    expect(deduplicatedPaths.length).toBe(4);

    const checkRes = await checkCardAssets(sets, 2, tmpDir);
    expect(checkRes.total).toBe(4);
    // Errors should be reported for missing, empty, and corrupt cards (3 total)
    expect(checkRes.errors.length).toBe(3);

    const errorPaths = checkRes.errors.map((e) => e.path);
    expect(errorPaths.some((p) => p.includes('card-missing'))).toBe(true);
    expect(errorPaths.some((p) => p.includes('card-empty'))).toBe(true);
    expect(errorPaths.some((p) => p.includes('card-corrupt'))).toBe(true);
  });
});
