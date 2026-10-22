/**
 * The set registry. Plain data + engine validation, no Vite APIs, so Node
 * scripts (CI verification, card builds) can import it too.
 *
 * Adding a set: create `sets/<id>/set.json` + art, import it below, run
 * `npm run cards` and `npm run check:sets -- --update`.
 * Changing a released set: copy its current set.json to `set.v<N>.json`,
 * import that here too (old proofs need it), then bump `version`.
 */
import { setKey, validateSet, type CardDefinition, type SetDefinition } from '../../engine';
import genesis from './genesis/set.json';
import webAncientsV1 from './web-ancients/set.v1.json';
import webAncients from './web-ancients/set.json';
import vineAndDankV1 from './vine-and-dank/set.v1.json';
import vineAndDank from './vine-and-dank/set.json';
import lockdownLoreV1 from './lockdown-lore/set.v1.json';
import lockdownLore from './lockdown-lore/set.json';
import genAlphaUprisingV1 from './gen-alpha-uprising/set.v1.json';
import genAlphaUprising from './gen-alpha-uprising/set.json';
import peakBrainRot from './peak-brain-rot/set.json';
import italianBrainrotDeepCutsV1 from './italian-brainrot-deep-cuts/set.v1.json';
import italianBrainrotDeepCuts from './italian-brainrot-deep-cuts/set.json';
import sixSevenSeason from './six-seven-season/set.json';
import springBreakdown from './spring-breakdown/set.json';
import rightNowV1 from './right-now/set.v1.json';
import rightNow from './right-now/set.json';

/** Every version of every set. Display order = timeline order (Genesis first). */
// Version 1 of each set is from before card modifiers; version 2 adds them (spec section 5.4).
export const ALL_SET_VERSIONS: SetDefinition[] = [
  genesis,
  webAncientsV1,
  webAncients,
  vineAndDankV1,
  vineAndDank,
  lockdownLoreV1,
  lockdownLore,
  genAlphaUprisingV1,
  genAlphaUprising,
  peakBrainRot,
  italianBrainrotDeepCutsV1,
  italianBrainrotDeepCuts,
  sixSevenSeason,
  springBreakdown,
  rightNowV1,
  rightNow,
].map((s) => validateSet(s));

const byKey = new Map(ALL_SET_VERSIONS.map((s) => [setKey(s), s]));
if (byKey.size !== ALL_SET_VERSIONS.length) throw new Error('Duplicate set@version in registry');

/** The latest version of each set, in timeline order. These are the packs you can open. */
export const SETS: SetDefinition[] = [...new Map(ALL_SET_VERSIONS.map((s) => [s.id, s])).values()].map(
  (s) => ALL_SET_VERSIONS.filter((v) => v.id === s.id).sort((a, b) => b.version - a.version)[0],
);

/** Sets you can open packs from: released and not archived (drafts are opt-in previews). */
export const isOpenable = (set: SetDefinition): boolean => !set.draft && !set.archivedAt;

/** The pack new players land on: the newest openable set. */
export const DEFAULT_SET_ID = [...SETS].reverse().find(isOpenable)!.id;

/**
 * A short set code, like the one printed next to a real card's number ("SOS 007/012"): the
 * initials of the set's words (3-4 letters), or the first three letters of a one-word name.
 */
export const setCode = (set: Pick<SetDefinition, 'name'>): string => {
  const words = set.name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w));
  const code = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] ?? '').slice(0, 3);
  return code.toUpperCase();
};

const NEW_FOR_DAYS = 45;

/**
 * The newest drop gets a "New" badge for a while. Sets never have "now" in their name (it goes
 * stale the day the next one ships); newness is worked out here from the release date instead.
 */
export const isNewSet = (set: SetDefinition, now = Date.now()): boolean =>
  set.id === DEFAULT_SET_ID && now - Date.parse(set.releasedAt) < NEW_FOR_DAYS * 24 * 60 * 60 * 1000;

export const getSet = (id: string, version: number): SetDefinition | undefined => byKey.get(`${id}@${version}`);

export const getLatestSet = (id: string): SetDefinition | undefined => SETS.find((s) => s.id === id);

/** Card definition by set + card id (searches every version, newest first). */
export const getCardDefinition = (setId: string, cardId: string): CardDefinition | undefined => {
  for (const set of ALL_SET_VERSIONS.filter((s) => s.id === setId).sort((a, b) => b.version - a.version)) {
    const card = set.cards.find((c) => c.id === cardId);
    if (card) return card;
  }
  return undefined;
};

/** Collection key for a card: unique across sets. */
export const cardKey = (setId: string, cardId: string): string => `${setId}/${cardId}`;
