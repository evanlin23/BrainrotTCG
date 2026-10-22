/**
 * Bounded, seeded malformed-input properties for Save & backup admission (#749). A refused file must
 * leave every stored byte, the identity included, as it was; an admitted one stores each supplied field
 * exactly as the file holds it. The hand-picked cases live in saveFile.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { ALL_CARDS } from '../data/cards';
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';
import { importSaveFile } from './saveFile';
import { forAll, jsonValue, replaceSomewhere, SAFE_COUNTERS, unicodeText, UNSAFE_COUNTERS, type Rng } from '../test/property';

const PLAYER_KEY = 'brainrot-player-v1';
const UNREADABLE = "Couldn't read or store that file. Is it a save exported from Save & backup?";
const FIELD_KEYS: Record<string, string> = {
  collection: STORAGE_KEYS.COLLECTION, collectionRecovery: STORAGE_KEYS.COLLECTION_RECOVERY, achievements: STORAGE_KEYS.ACHIEVEMENTS,
  stats: STORAGE_KEYS.STATS, hallOfFame: STORAGE_KEYS.HALL_OF_FAME, pulls: STORAGE_KEYS.PULLS, history: STORAGE_KEYS.HISTORY,
  bestCards: STORAGE_KEYS.BEST_CARDS, settings: STORAGE_KEYS.SETTINGS,
};

// Disposable keys, never a player's.
const player = (secretKey = 'aa'.repeat(32), nextNonce: unknown = 7, createdAt: unknown = 1) =>
  JSON.stringify({ secretKey, name: 'Combo Miner', nextNonce, createdAt });
const fixture = (): Record<string, unknown> => ({
  version: 2, exportedAt: '2026-10-14T00:00:00.000Z', dataVersion: CURRENT_DATA_VERSION,
  player: player(),
  collection: JSON.stringify({ [ALL_CARDS[0].key]: { card: ALL_CARDS[0], normalCount: 1, holoCount: 0 } }),
  stats: JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackCards: [] }),
  achievements: '{}', hallOfFame: '{}', settings: '{"particlesEnabled":true,"effectsVolume":1}',
  history: JSON.stringify([{ s: ALL_CARDS[0].setId, v: 1, n: 0, k: 'abc', c: ALL_CARDS[0].id, h: 'No Match', x: 10, t: 1 }]),
});
const ENCODED = Object.keys(fixture()).filter((field) => typeof fixture()[field] === 'string' && field !== 'exportedAt');

const ORIGINAL: [string, string][] = [
  [PLAYER_KEY, player('bb'.repeat(32), 12)],
  [STORAGE_KEYS.COLLECTION, '{}'],
  [STORAGE_KEYS.STATS, '{"packsOpened":12,"holoCards":{}}'],
  [STORAGE_KEYS.SETTINGS, '{"particlesEnabled":false}'],
];
const store = new Map<string, string>();
const write = vi.fn((key: string, value: string) => { store.set(key, value); });
const resetStorage = () => {
  store.clear();
  for (const [key, value] of ORIGINAL) store.set(key, value);
  write.mockClear();
};

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: write,
    removeItem: (key: string) => { store.delete(key); },
  });
  resetStorage();
});
afterEach(() => vi.unstubAllGlobals());

const parses = (text: string) => { try { JSON.parse(text); return true; } catch { return false; } };

/** One random edit to the fixture save, described for the failure message. */
const editedSave = (rng: Rng): { raw: string; edit: string } => {
  const save = fixture();
  const field = rng.pick([...ENCODED, 'version', 'dataVersion', 'exportedAt', unicodeText(rng, 3)]);
  switch (rng.int(0, 4)) {
    case 0: {
      save[field] = jsonValue(rng);
      return { raw: JSON.stringify(save), edit: `${field} as a bare value` };
    }
    case 1: {
      save[field] = JSON.stringify(jsonValue(rng));
      return { raw: JSON.stringify(save), edit: `${field} as encoded JSON of another shape` };
    }
    case 2: {
      const target = rng.pick(ENCODED);
      const { value, path } = replaceSomewhere(rng, JSON.parse(save[target] as string), jsonValue(rng, 2));
      save[target] = JSON.stringify(value);
      return { raw: JSON.stringify(save), edit: `${target} with ${path.join('.') || 'its root'} replaced` };
    }
    case 3: {
      const counter = rng.pick([...SAFE_COUNTERS, ...UNSAFE_COUNTERS, null, '7', true]);
      const which = rng.bool() ? 'nextNonce' : 'createdAt';
      save.player = which === 'nextNonce' ? player(undefined, counter) : player(undefined, 7, counter);
      return { raw: JSON.stringify(save), edit: `player ${which} ${String(counter)}` };
    }
    default: {
      const raw = JSON.stringify(save);
      const at = rng.int(0, raw.length);
      const cut = rng.bool() ? rng.int(1, 3) : 0;
      return { raw: raw.slice(0, at) + (cut ? '' : rng.pick([...'{}[]",:\\0-e', '\u0000', '﻿', '\ud800', 'é'])) + raw.slice(at + cut), edit: `text edit at ${at}` };
    }
  }
};

type Importer = (raw: string) => string | null;

/** Refusals change nothing; admissions store each supplied field byte for byte; validators never throw. */
const admissionProperty = (importer: Importer, outcomes = { accepted: 0, rejected: 0 }) => forAll(
  'save admission',
  { seed: 749_101, runs: 400 },
  (rng) => editedSave(rng),
  ({ raw }) => {
    resetStorage();
    const before = new Map(store);
    const result = importer(raw);
    if (result !== null) {
      outcomes.rejected++;
      expect(store, 'a refused import leaves storage and identity byte-identical').toEqual(before);
      // Every encoded field parses, so a validator threw if the file was called unreadable.
      const save: unknown = parses(raw) ? JSON.parse(raw) : null;
      if (save && typeof save === 'object' && !Array.isArray(save)
        && Object.values(save).every((v) => typeof v !== 'string' || v === (save as { exportedAt?: unknown }).exportedAt || parses(v))) {
        expect(result).not.toBe(UNREADABLE);
      }
      return;
    }
    outcomes.accepted++;
    const save = JSON.parse(raw) as Record<string, unknown>;
    for (const [field, key] of Object.entries(FIELD_KEYS)) {
      if (typeof save[field] === 'string') expect(store.get(key), field).toBe(save[field]);
    }
    expect(store.get(DATA_VERSION_KEY)).toBe(String(save.dataVersion ?? CURRENT_DATA_VERSION));
    if (typeof save.player === 'string') expect(JSON.parse(store.get(PLAYER_KEY)!).secretKey).toBe(JSON.parse(save.player).secretKey);
  },
);

describe('Save & backup admission properties', () => {
  it('admits the unedited fixture', () => {
    expect(importSaveFile(JSON.stringify(fixture()))).toBeNull();
  });

  it('refuses every truncation of a valid save without writes', () => {
    const raw = JSON.stringify(fixture());
    for (let n = 0; n < raw.length; n++) {
      resetStorage();
      const before = new Map(store);
      expect(importSaveFile(raw.slice(0, n)), `truncated to ${n}`).not.toBeNull();
      expect(write).not.toHaveBeenCalled();
      expect(store).toEqual(before);
    }
  });

  it('refuses edited saves cleanly and stores admitted fields verbatim', async () => {
    const outcomes = { accepted: 0, rejected: 0 };
    await admissionProperty(importSaveFile, outcomes);
    expect(outcomes.accepted, 'some edited saves are admitted').toBeGreaterThan(0);
    expect(outcomes.rejected, 'some edited saves are refused').toBeGreaterThan(0);
  });

  it.each(SAFE_COUNTERS)('admits ticket counter %s exactly', (nextNonce) => {
    expect(importSaveFile(JSON.stringify({ ...fixture(), player: player(undefined, nextNonce) }))).toBeNull();
    expect(JSON.parse(store.get(PLAYER_KEY)!).nextNonce).toBe(nextNonce);
  });

  it.each(UNSAFE_COUNTERS)('refuses ticket counter %s without writes', (nextNonce) => {
    const before = new Map(store);
    expect(importSaveFile(JSON.stringify({ ...fixture(), player: player(undefined, nextNonce) }))).not.toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(store).toEqual(before);
  });

  it('detects an injected admission mistake (a field written before validation), naming the seed', async () => {
    const writesEarly: Importer = (raw) => {
      try {
        const save: unknown = JSON.parse(raw);
        const settings = save && typeof save === 'object' ? (save as Record<string, unknown>).settings : undefined;
        if (typeof settings === 'string') localStorage.setItem(STORAGE_KEYS.SETTINGS, settings);
      } catch { /* the real import reports it */ }
      return importSaveFile(raw);
    };
    await expect(admissionProperty(writesEarly)).rejects.toThrow(/seed 749101, case \d+ of 400/);
  });
});
