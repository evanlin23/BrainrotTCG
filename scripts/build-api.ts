/**
 * Generates static fan-tool and developer API JSON files (#61):
 * - /api/sets.json: Canonical set definitions, pack sizes, exact odds, and card lists.
 * - /api/cards.json: Full card catalog with keys, rarities, base points, captions, and flavor text.
 * - /api/hall-of-fame.json: Canonical endpoint for the latest verified Hall of Fame pulls.
 *
 * Fan tools, Discord bots, wikis, and simulators can fetch these directly from GitHub Pages or
 * Cloudflare Pages without scraping HTML or bundling engine dependencies.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_SET_VERSIONS, isOpenable, SETS } from '../src/content/sets/index.ts';
import { cardPoints, type SetDefinition } from '../src/engine/index.ts';
import { isMainModule } from './main-module.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export interface ApiSetCard {
  id: string;
  name: string;
  rarity: string;
  caption: string | null;
  flavor: string | null;
}

export interface ApiSetItem {
  id: string;
  name: string;
  version: number;
  era: string;
  packSize: number;
  odds: Record<string, number>;
  holoOdds: number;
  modifiers: number | null;
  draft: boolean;
  archivedAt: string | null;
  palette: readonly string[] | null;
  cardCount: number;
  cards: ApiSetCard[];
}

export interface ApiSetsCatalog {
  version: number;
  totalSets: number;
  sets: ApiSetItem[];
  allVersions: ApiSetItem[];
}

export interface ApiCardItem {
  key: string;
  setId: string;
  id: string;
  name: string;
  rarity: string;
  points: number;
  image: string;
  caption: string | null;
  flavor: string | null;
  isOpenable: boolean;
}

export interface ApiCardsCatalog {
  version: number;
  totalCards: number;
  cards: ApiCardItem[];
}

export const formatSetItem = (set: SetDefinition): ApiSetItem => ({
  id: set.id,
  name: set.name,
  version: set.version,
  era: set.era,
  packSize: set.packSize,
  odds: set.odds,
  holoOdds: set.holoOdds,
  modifiers: set.modifiers ?? null,
  draft: !!set.draft,
  archivedAt: set.archivedAt ?? null,
  palette: set.palette ?? null,
  cardCount: set.cards.length,
  cards: set.cards.map((c) => ({
    id: c.id,
    name: c.name,
    rarity: c.rarity,
    caption: c.caption ?? null,
    flavor: c.flavor ?? null,
  })),
});

export const buildSetsCatalog = (
  sets: readonly SetDefinition[] = SETS,
  versions: readonly SetDefinition[] = ALL_SET_VERSIONS,
): ApiSetsCatalog => ({
  version: 1,
  totalSets: sets.length,
  sets: sets.map(formatSetItem),
  allVersions: versions.map(formatSetItem),
});

export const buildCardsCatalog = (sets: readonly SetDefinition[] = SETS): ApiCardsCatalog => {
  const cards: ApiCardItem[] = [];
  const seenKeys = new Set<string>();

  for (const set of sets) {
    const openable = isOpenable(set);
    for (const card of set.cards) {
      const key = `${set.id}/${card.id}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        cards.push({
          key,
          setId: set.id,
          id: card.id,
          name: card.name,
          rarity: card.rarity,
          points: cardPoints(card.rarity, false),
          image: `assets/cards/${set.id}/${card.id}.webp`,
          caption: card.caption ?? null,
          flavor: card.flavor ?? null,
          isOpenable: openable,
        });
      }
    }
  }

  return {
    version: 1,
    totalCards: cards.length,
    cards,
  };
};

export interface GenerateApiOptions {
  outDirs?: string[];
  publicDir?: string;
}

export const generateApiFiles = (options: GenerateApiOptions = {}) => {
  const publicDir = options.publicDir ?? path.join(ROOT, 'public');
  const targetDirs = options.outDirs ?? [path.join(publicDir, 'api')];

  const setsCatalog = buildSetsCatalog();
  const cardsCatalog = buildCardsCatalog();

  const hofSourcePath = path.join(publicDir, 'hall-of-fame.json');
  const hofContent = existsSync(hofSourcePath) ? readFileSync(hofSourcePath, 'utf8') : '[]\n';

  const setsJson = JSON.stringify(setsCatalog, null, 2) + '\n';
  const cardsJson = JSON.stringify(cardsCatalog, null, 2) + '\n';

  for (const dir of targetDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'sets.json'), setsJson);
    writeFileSync(path.join(dir, 'cards.json'), cardsJson);
    writeFileSync(path.join(dir, 'hall-of-fame.json'), hofContent);
  }

  return {
    sets: setsCatalog.totalSets,
    cards: cardsCatalog.totalCards,
    dirs: targetDirs,
  };
};

if (isMainModule(import.meta.url)) {
  const distApi = path.join(ROOT, 'dist', 'api');
  const outDirs = [path.join(ROOT, 'public', 'api')];
  if (existsSync(path.join(ROOT, 'dist'))) {
    outDirs.push(distApi);
  }
  const result = generateApiFiles({ outDirs });
  console.log(`Generated static API (${result.sets} sets, ${result.cards} cards) in ${result.dirs.join(', ')}`);
}
