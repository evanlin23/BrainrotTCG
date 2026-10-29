import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_SET_VERSIONS, SETS } from '../src/content/sets/index.ts';
import { cardPoints, type Rarity, type SetDefinition } from '../src/engine/index.ts';
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
      expect(catalog.totalSets).toBe(SETS.filter((s) => !s.draft).length);
      expect(catalog.sets.length).toBe(catalog.totalSets);
      expect(catalog.allVersions.length).toBe(ALL_SET_VERSIONS.filter((s) => !s.draft).length);

      // Verify every set's odds sum to 10000
      for (const set of catalog.sets) {
        const sum = Object.values(set.odds).reduce((a, b) => a + b, 0);
        expect(sum).toBe(10000);
      }
    });
  });

  describe('buildCardsCatalog', () => {
    it('builds card catalog with consistent keys and points', () => {
      const catalog = buildCardsCatalog();
      expect(catalog.version).toBe(1);
      expect(catalog.totalCards).toBeGreaterThan(0);
      expect(catalog.cards.length).toBe(catalog.totalCards);

      for (const card of catalog.cards) {
        expect(card.key).toBe(`${card.setId}/${card.id}`);
        expect(card.points).toBe(cardPoints(card.rarity as Rarity, false));
        expect(typeof card.isOpenable).toBe('boolean');
      }
    });
  });

  describe('card art', () => {
    it('gives no image address, since card art is published only under content-hashed names', () => {
      // An unhashed assets/cards/<set>/<id>.webp is a dead link (src/content/art.ts hashes the art);
      // scripts/check-site.ts also fails a build whose catalogs name an assets/ file it doesn't have.
      const cards = buildCardsCatalog();
      for (const card of cards.cards) expect(card).not.toHaveProperty('image');
      expect(JSON.stringify([cards, buildSetsCatalog()])).not.toMatch(/"assets\//);
    });
  });

  describe('draft sets', () => {
    const draft: SetDefinition = { ...SETS[0], id: 'draft-fixture', name: 'Draft Fixture', draft: true };

    it('leaves draft sets out of sets and allVersions', () => {
      const catalog = buildSetsCatalog([...SETS, draft], [...ALL_SET_VERSIONS, draft]);
      expect(catalog.totalSets).toBe(SETS.filter((s) => !s.draft).length);
      expect(catalog.sets.map((s) => s.id)).not.toContain('draft-fixture');
      expect(catalog.allVersions.map((s) => s.id)).not.toContain('draft-fixture');
      expect(catalog.sets.every((s) => !s.draft)).toBe(true);
    });

    it("leaves a draft set's cards out of the card catalog", () => {
      const catalog = buildCardsCatalog([...SETS, draft]);
      expect(catalog.cards.some((c) => c.setId === 'draft-fixture')).toBe(false);
      expect(catalog).toEqual(buildCardsCatalog(SETS));
    });
  });

  describe('generateApiFiles', () => {
    it('writes sets.json, cards.json, and hall-of-fame.json into target directory', () => {
      const outDir = path.join(tmpDir, 'api');
      const result = generateApiFiles({
        outDirs: [outDir],
        publicDir: path.join(ROOT, 'public'),
      });

      expect(result.sets).toBe(SETS.filter((s) => !s.draft).length);
      expect(existsSync(path.join(outDir, 'sets.json'))).toBe(true);
      expect(existsSync(path.join(outDir, 'cards.json'))).toBe(true);
      expect(existsSync(path.join(outDir, 'hall-of-fame.json'))).toBe(true);

      const parsedSets = JSON.parse(readFileSync(path.join(outDir, 'sets.json'), 'utf8'));
      expect(parsedSets.totalSets).toBe(result.sets);

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
