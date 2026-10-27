import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_SET_VERSIONS, SETS } from '../src/content/sets/index.ts';
import { cardPoints, type Rarity } from '../src/engine/index.ts';
import {
  buildCardsCatalog,
  buildSetsCatalog,
  formatSetItem,
  generateApiFiles,
} from './build-api.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('build-api', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'brainrot-api-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('buildSetsCatalog', () => {
    it('formats set items with all required API fields', () => {
      const set = SETS[0];
      const item = formatSetItem(set);

      expect(item.id).toBe(set.id);
      expect(item.name).toBe(set.name);
      expect(item.version).toBe(set.version);
      expect(item.packSize).toBe(set.packSize);
      expect(item.odds).toEqual(set.odds);
      expect(item.holoOdds).toBe(set.holoOdds);
      expect(item.cardCount).toBe(set.cards.length);
      expect(item.cards.length).toBe(set.cards.length);
      expect(item.cards[0]).toHaveProperty('id');
      expect(item.cards[0]).toHaveProperty('name');
      expect(item.cards[0]).toHaveProperty('rarity');
    });

    it('builds catalog matching current SETS and ALL_SET_VERSIONS', () => {
      const catalog = buildSetsCatalog();
      expect(catalog.version).toBe(1);
      expect(catalog.totalSets).toBe(SETS.length);
      expect(catalog.sets.length).toBe(SETS.length);
      expect(catalog.allVersions.length).toBe(ALL_SET_VERSIONS.length);

      // Verify every set's odds sum to 10000
      for (const set of catalog.sets) {
        const sum = Object.values(set.odds).reduce((a, b) => a + b, 0);
        expect(sum).toBe(10000);
      }
    });
  });

  describe('buildCardsCatalog', () => {
    it('builds card catalog with consistent keys, points, and paths', () => {
      const catalog = buildCardsCatalog();
      expect(catalog.version).toBe(1);
      expect(catalog.totalCards).toBeGreaterThan(0);
      expect(catalog.cards.length).toBe(catalog.totalCards);

      for (const card of catalog.cards) {
        expect(card.key).toBe(`${card.setId}/${card.id}`);
        expect(card.points).toBe(cardPoints(card.rarity as Rarity, false));
        expect(card.image).toBe(`assets/cards/${card.setId}/${card.id}.webp`);
        expect(typeof card.isOpenable).toBe('boolean');
      }
    });
  });

  describe('generateApiFiles', () => {
    it('writes sets.json, cards.json, and hall-of-fame.json into target directory', () => {
      const outDir = path.join(tmpDir, 'api');
      const result = generateApiFiles({
        outDirs: [outDir],
        publicDir: path.join(ROOT, 'public'),
      });

      expect(result.sets).toBe(SETS.length);
      expect(existsSync(path.join(outDir, 'sets.json'))).toBe(true);
      expect(existsSync(path.join(outDir, 'cards.json'))).toBe(true);
      expect(existsSync(path.join(outDir, 'hall-of-fame.json'))).toBe(true);

      const parsedSets = JSON.parse(readFileSync(path.join(outDir, 'sets.json'), 'utf8'));
      expect(parsedSets.totalSets).toBe(SETS.length);

      const parsedCards = JSON.parse(readFileSync(path.join(outDir, 'cards.json'), 'utf8'));
      expect(parsedCards.totalCards).toBe(result.cards);
    });
  });

  describe('checked-in static files in public/api', () => {
    it('ensures public/api/sets.json is up to date with registry', () => {
      const publicPath = path.join(ROOT, 'public', 'api', 'sets.json');
      expect(existsSync(publicPath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(publicPath, 'utf8'));
      const generated = buildSetsCatalog();
      expect(onDisk).toEqual(generated);
    });

    it('ensures public/api/cards.json is up to date with registry', () => {
      const publicPath = path.join(ROOT, 'public', 'api', 'cards.json');
      expect(existsSync(publicPath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(publicPath, 'utf8'));
      const generated = buildCardsCatalog();
      expect(onDisk).toEqual(generated);
    });
  });
});
