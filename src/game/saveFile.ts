/** Settings backup files: preflight every supplied field before changing browser storage. */
import { STORAGE_KEYS } from '../constants';
import { FINISH_MULTIPLIER, RARITIES_RAREST_FIRST, type Rarity } from '../engine';
import { getCard } from '../data/cards';
import { CURRENT_DATA_VERSION, migrateCardKey, setDataVersion } from '../utils/migrations';
import { backUpSave, hasProgress } from './move';
import { importPlayer, parsePlayer } from './player';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string';
const boolean = (value: unknown) => typeof value === 'boolean';
const optional = (value: RecordValue, key: string, valid: (v: unknown) => boolean) => !(key in value) || valid(value[key]);
const values = (value: unknown, valid: (v: unknown) => boolean) => record(value) && Object.values(value).every(valid);
const finish = (value: unknown) => text(value) && Object.prototype.hasOwnProperty.call(FINISH_MULTIPLIER, value);
const cards = (value: unknown) => Array.isArray(value) && value.every(card);
const card = (value: unknown): boolean => record(value) && text(value.id)
  && ['key', 'setId', 'name', 'image', 'caption', 'flavor'].every((key) => optional(value, key, text))
  && ['isHolo', 'isRevealed', 'misprint', 'isNew'].every((key) => optional(value, key, boolean))
  && (getCard(text(value.key) ? value.key : migrateCardKey(value.id)) !== undefined
    || (text(value.name) && text(value.image) && text(value.rarity)))
  && optional(value, 'rarity', (v) => text(v) && RARITIES_RAREST_FIRST.includes(v as Rarity))
  && optional(value, 'uniqueId', number) && optional(value, 'finish', (v) => v === null || finish(v));
const ref = (value: unknown) => record(value) && text(value.setId) && count(value.setVersion) && count(value.nonce)
  && optional(value, 'publicKeyHex', text);

const collection = (value: unknown) => values(value, (item) => record(item) && card(item.card)
  && ['normalCount', 'holoCount', 'count', 'misprints'].every((key) => optional(item, key, count))
  && optional(item, 'modifierPoints', number) && optional(item, 'finishes', (v) => values(v, count) && record(v) && Object.keys(v).every((key) => finish(key))));
const achievements = (value: unknown) => values(value, (item) => number(item) || (record(item) && number(item.unlockedAt)
  && optional(item, 'pack', cards) && optional(item, 'ref', ref)));
const stats = (value: unknown) => record(value) && optional(value, 'packsOpened', count)
  && optional(value, 'holoCards', (v) => values(v, boolean))
  && ['highestPackValue', 'highestPackFlexValue', 'highestPackBaseValue', 'highestPackMultiplier'].every((key) => optional(value, key, number))
  && optional(value, 'highestPackHandName', text) && optional(value, 'highestPackCards', cards)
  && optional(value, 'highestPackRef', ref) && optional(value, 'highestPackLegacy', boolean);
const hallOfFame = (value: unknown) => record(value)
  && ['first4OfAKind', 'firstFullHouse'].every((key) => optional(value, key, (v) => record(v)
    && boolean(v.achieved) && number(v.date) && optional(v, 'cardId', text) && optional(v, 'cards', (c) => values(c, count))));
const settings = (value: unknown) => record(value)
  && ['soundEnabled', 'particlesEnabled', 'pauseBigPulls', 'showDraftSets'].every((key) => optional(value, key, boolean))
  && ['musicVolume', 'effectsVolume'].every((key) => optional(value, key, (v) => number(v) && v <= 1))
  && ['cardBack', 'packFoil'].every((key) => optional(value, key, text));
const history = (value: unknown) => Array.isArray(value) && value.every((entry) => record(entry)
  && text(entry.s) && count(entry.v) && count(entry.n) && text(entry.k)
  && optional(entry, 'c', text) && text(entry.h) && number(entry.x) && number(entry.t));
const pulls = (value: unknown) => Array.isArray(value) && value.every((entry) => ref(entry)
  && record(entry) && number(entry.score) && text(entry.hand) && number(entry.openedAt));

const SAVE_FIELDS = [
  ['collection', STORAGE_KEYS.COLLECTION, collection],
  ['achievements', STORAGE_KEYS.ACHIEVEMENTS, achievements],
  ['stats', STORAGE_KEYS.STATS, stats],
  ['hallOfFame', STORAGE_KEYS.HALL_OF_FAME, hallOfFame],
  ['pulls', STORAGE_KEYS.PULLS, pulls],
  ['history', STORAGE_KEYS.HISTORY, history],
  ['settings', STORAGE_KEYS.SETTINGS, settings],
] as const;

/**
 * Omitted/null fields preserve existing storage, as older exports omitted fields introduced later.
 * This validates structure, not the authenticity of cached cards/scores, and is not an atomic commit.
 */
export const importSaveFile = (raw: string): string | null => {
  try {
    const save: unknown = JSON.parse(raw);
    if (!record(save) || (save.version !== 1 && save.version !== 2)
      || !text(save.exportedAt) || !Number.isFinite(Date.parse(save.exportedAt))) {
      return "That file isn't a supported Brainrot TCG save.";
    }
    const dataVersion = save.dataVersion === undefined ? (save.version === 1 ? 1 : CURRENT_DATA_VERSION) : save.dataVersion;
    if (!count(dataVersion) || dataVersion < 1 || dataVersion > CURRENT_DATA_VERSION) {
      return 'This save uses an unsupported data version.';
    }
    const staged: [string, string][] = [];
    for (const [field, key, valid] of SAVE_FIELDS) {
      const fieldValue = save[field];
      if (fieldValue === undefined || fieldValue === null) continue;
      if (typeof fieldValue !== 'string' || !valid(JSON.parse(fieldValue))) {
        return `The ${field} in this save is invalid. Nothing was imported.`;
      }
      staged.push([key, fieldValue]);
    }
    if (save.player !== undefined && save.player !== null && (typeof save.player !== 'string' || !parsePlayer(save.player))) {
      return 'The player identity in this save is invalid. Nothing was imported.';
    }
    if (hasProgress()) backUpSave('brainrot-before-import-v1');
    for (const [key, value] of staged) localStorage.setItem(key, value);
    if (typeof save.player === 'string' && !importPlayer(save.player)) {
      return "Couldn't import the player identity.";
    }
    setDataVersion(dataVersion);
    return null;
  } catch {
    return "Couldn't read or store that file. Is it a save exported from Settings?";
  }
};
