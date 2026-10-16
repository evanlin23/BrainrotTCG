/**
 * Opening packs and turning them into shareable, verifiable pull proofs.
 */
import { getCard, scoreCards, type Card } from '../data/cards';
import {
  encodeProof,
  generatePack,
  packSeedFromTicket,
  setKey,
  signProof,
  verifyProof,
  type Finish,
  type PackScore,
  type Rarity,
  type SetDefinition,
  type VerifiedPull,
} from '../engine';
import { getSet } from '../content/sets';
import { allocateNonce, getPlayer, peekNonce } from './player';
import { recordPack } from './history';
import { decodeCard, encodeCard, modifiersFor } from './cardCode';
import { STORAGE_KEYS } from '../constants';
import { previewOf, previewPath } from './previewLinks';
import { revealOrder } from './reveal';
import { getTicket, prefetchTicket } from './ticketMiner';
import type { CardWithMeta } from '../components/cards/Card';

/** Enough to re-derive and re-sign a pull later (e.g. to share a past best pack). */
export interface PullRef {
  setId: string;
  setVersion: number;
  nonce: number;
  /** The key that opened it, or a prefix of it. Only that key can share it (older refs have none). */
  publicKeyHex?: string;
}

export interface OpenedPack extends PullRef {
  cards: CardWithMeta[];
  score: PackScore;
  openedAt: number;
  /** Already counted in the stats and pack milestones: only its cards still need to be stored. */
  counted?: boolean;
  /** Taken from an older build's one-pack entry, which keeps it until a stored collection holds it. */
  legacy?: boolean;
  /**
   * Its ticket mapping couldn't be written to the history, or it couldn't be put on the pending shelf
   * (storage full or blocked, or the shelf full): warn that saving failed.
   */
  unrecorded?: boolean;
}

export const toCardsWithMeta = (pulled: { setId: string; cardId: string; isHolo: boolean; finish?: Finish | null; misprint?: boolean }[]): CardWithMeta[] =>
  pulled.map((p) => {
    const card: Card | undefined = getCard(`${p.setId}/${p.cardId}`);
    if (!card) throw new Error(`Unknown card ${p.setId}/${p.cardId}`);
    return { ...card, uniqueId: Math.random(), isRevealed: false, isHolo: p.isHolo, ...(p.finish !== undefined ? { finish: p.finish, misprint: !!p.misprint } : {}) };
  });

/** Mine the next pack's ticket in the background. */
export const prefetchNextPack = (set: SetDefinition) => {
  void getTicket(setKey(set), getPlayer().publicKey, peekNonce())
    .then((ticket) => {
      // And its cards' pictures, so they're cached before the tear (and there if the connection drops).
      for (const card of generatePack(set, packSeedFromTicket(ticket))) {
        const image = getCard(`${card.setId}/${card.cardId}`)?.image;
        if (image) new Image().src = image;
      }
    })
    .catch(() => undefined);
};

/** Open a pack: consume a ticket number, mine (or reuse) its ticket, derive the cards. */
export const openPack = async (set: SetDefinition): Promise<OpenedPack> => {
  const { nonce, player } = allocateNonce();
  const ticket = await getTicket(setKey(set), player.publicKey, nonce);
  const cards = toCardsWithMeta(generatePack(set, packSeedFromTicket(ticket)));
  prefetchTicket(setKey(set), player.publicKey, nonce + 1);
  const pack: OpenedPack = {
    setId: set.id,
    setVersion: set.version,
    nonce,
    publicKeyHex: player.publicKeyHex,
    cards,
    score: scoreCards(cards),
    openedAt: Date.now(),
  };
  // Recorded now, not after the reveal: the ticket is spent either way, and a profile needs every one.
  if (!recordPack(pack)) pack.unrecorded = true;
  // Not kept for the next load (storage refused, or the shelf is full): warn as well.
  if (!savePendingPack(pack)) pack.unrecorded = true;
  return pack;
};

/*
 * The collection only takes a pack once its reveal is done (so achievements don't spoil it), but the
 * ticket is spent the moment it opens. Until the collection has it, the pack waits here, so a reload,
 * a closed tab or a dead phone mid-reveal can't lose it: the app adds it on the next load.
 *
 * The shelf is a list under PENDING_PACKS, so no owed pack replaces another. Older builds keep one
 * pack under PENDING_PACK instead, and would delete a list found there (or fail to clear it), so this
 * build never puts a list or a new pack there. An older tab or a rollback never sees the list, so it
 * can't drop or re-add a listed pack; the next load of this build still adds them.
 * A pack an older build left under PENDING_PACK is added on load but stays there until a stored
 * collection holds it, so an older tab that stores and clears that pack still reaches the only copy.
 * If the collection can't be stored, it is put back there (marked), only while that entry still holds
 * it: otherwise the tab that took or stored it has it. It never moves to the list, where an older tab's
 * clear can't reach it and the next load would add it again.
 */
interface PendingPack {
  s: string;
  v: number;
  n: number;
  k?: string;
  c: string;
  t: number;
  /** 1 once the pack has counted (it was put back after that); entries without it count when added. */
  d?: 1;
}

/**
 * Enough for every pack a blocked collection can owe in one visit; past it, the history still has them.
 * Another player's packs on the shelf count toward it too.
 */
const SHELF_LIMIT = 50;

/** Every pack under a key, a list or one entry (empty when it can't be read). */
const readEntries = (key: string): PendingPack[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return (Array.isArray(stored) ? stored : [stored]).filter((p: Partial<PendingPack> | null): p is PendingPack => typeof p?.n === 'number');
  } catch {
    return [];
  }
};

const isMine = (p: PendingPack) => !p.k || p.k === getPlayer().publicKeyHex;
/** This player's packs under a key. */
const readPacks = (key: string): PendingPack[] => readEntries(key).filter(isMine);
const samePack = (a: PendingPack, b: PendingPack) => a.k === b.k && a.n === b.n;
/**
 * Another player's packs that storage refused to keep on the shelf (see takeOff). This tab holds them
 * and writes them back with its next shelf write; one that turns up on the shelf again isn't held.
 */
let unshelved: PendingPack[] = [];
/**
 * Another player's packs on the shelf, and any this tab holds for it. They stay for that player's next
 * load: a tab whose player another tab switched leaves the packs it opened there (see App).
 */
const readOthers = (): PendingPack[] => {
  const stored = readEntries(STORAGE_KEYS.PENDING_PACKS);
  unshelved = unshelved.filter((p) => !stored.some((q) => samePack(p, q)));
  return [...stored.filter((p) => typeof p.k === 'string' && !isMine(p)), ...unshelved];
};

const readShelf = () => readPacks(STORAGE_KEYS.PENDING_PACKS);
/** The pack an older build left in its one-pack entry, if any. */
const readLegacy = () => readPacks(STORAGE_KEYS.PENDING_PACK);

/** False when storage refuses (out of space, or a SecurityError), so the shelf is as it was. */
const setShelf = (shelf: PendingPack[]): boolean => {
  try {
    if (shelf.length === 0) localStorage.removeItem(STORAGE_KEYS.PENDING_PACKS);
    else localStorage.setItem(STORAGE_KEYS.PENDING_PACKS, JSON.stringify(shelf));
    unshelved = unshelved.filter((p) => !shelf.some((q) => samePack(p, q)));
    return true;
  } catch {
    return false;
  }
};

/** Replaces this player's packs on the shelf with `mine`; another player's stay (readOthers). */
const writeShelf = (mine: PendingPack[]): boolean => setShelf([...readOthers(), ...mine]);

/**
 * Takes this player's packs that aren't in `mine` off the shelf: they are going into a collection, and
 * one left there would be added again on the next load. If storage won't write the shelf in place, the
 * shelf is removed and written again, since a quota that counts the old value beside the new one takes
 * the shorter shelf once the old one is gone. If it still refuses, the shelf keeps another player's packs
 * and drops this player's other owed ones (the history still has them). If it refuses even that, the
 * shelf goes back as it was if storage takes it: another player's owed packs aren't this tab's to drop,
 * though a pack taken off may then be added again.
 * - written: the shelf holds another player's packs and `mine`.
 * - kept: the shelf is as it was (storage wouldn't remove it, or it went back).
 * - others: the shelf holds another player's packs only, so `mine` were dropped.
 * - gone: nothing could be written back, so `mine` were dropped and this tab holds another player's
 *   packs till a shelf write takes them (see unshelved).
 */
const takeOff = (mine: PendingPack[]): 'written' | 'kept' | 'others' | 'gone' => {
  if (writeShelf(mine)) return 'written';
  const before = readEntries(STORAGE_KEYS.PENDING_PACKS);
  const others = readOthers();
  try {
    localStorage.removeItem(STORAGE_KEYS.PENDING_PACKS);
  } catch {
    return 'kept';
  }
  if (setShelf([...others, ...mine])) return 'written';
  // With no other player's packs, this removes nothing more and can't fail.
  if (mine.length > 0 && setShelf(others)) return 'others';
  if (setShelf(before)) return 'kept';
  unshelved = others;
  return 'gone';
};

/**
 * Load adds whatever pack this entry holds, without checking the collection, so a pack left here
 * after a collection holding it was stored would be added again. If storage won't remove the entry,
 * it is blanked instead: `null` reads as no pack, here and in older builds. False if neither works.
 */
const removeLegacy = (): boolean => {
  try {
    localStorage.removeItem(STORAGE_KEYS.PENDING_PACK);
    return true;
  } catch {
    try {
      localStorage.setItem(STORAGE_KEYS.PENDING_PACK, 'null');
      return true;
    } catch {
      return false;
    }
  }
};

const toPending = (pack: OpenedPack): PendingPack => ({
  s: pack.setId,
  v: pack.setVersion,
  n: pack.nonce,
  k: pack.publicKeyHex,
  c: pack.cards.map((c) => encodeCard({ id: c.id, holo: c.isHolo, finish: c.finish, misprint: c.misprint })).join(','),
  t: pack.openedAt,
  ...(pack.counted ? { d: 1 as const } : {}),
});

/**
 * Puts packs (back) on the shelf, beside the ones already owed; App does this when the collection
 * holding them couldn't be stored. A pack already there is replaced. False when storage refuses, or
 * when the shelf is full and a new pack couldn't go on it (the history still has that one).
 */
export const savePendingPack = (...packs: OpenedPack[]): boolean => {
  const shelf = readShelf();
  // Another player's packs take room too, and are never dropped for this player's.
  const room = SHELF_LIMIT - readOthers().length;
  let dropped = 0;
  let saved = true;
  for (const pack of packs) {
    const pending = toPending(pack);
    if (pack.legacy) {
      // Back into the older build's entry, if it still holds this pack (see above).
      if (!readLegacy().some((p) => p.n === pack.nonce)) continue;
      try {
        localStorage.setItem(STORAGE_KEYS.PENDING_PACK, JSON.stringify(pending));
      } catch {
        saved = false;
      }
      continue;
    }
    const at = shelf.findIndex((p) => p.n === pack.nonce);
    // A full shelf never drops an owed pack for a new one.
    if (at >= 0) shelf[at] = pending;
    else if (shelf.length < room) shelf.push(pending);
    else dropped++;
  }
  if (dropped > 0) console.error(`The pending pack shelf is full (${SHELF_LIMIT}): ${dropped} pack(s) not kept for the next load.`);
  return writeShelf(shelf) && saved && dropped === 0;
};

/** The collection has these packs now. */
export const clearPendingPack = (...nonces: number[]) => {
  if (nonces.length === 0) return;
  if (readLegacy().some((p) => nonces.includes(p.n)) && !removeLegacy()) {
    console.error("The older builds' pending pack couldn't be removed or blanked: the next load may add it again, though the collection has it.");
  }
  const shelf = readShelf();
  const kept = shelf.filter((p) => !nonces.includes(p.n));
  if (kept.length === shelf.length) {
    // Nothing to take off, but another player's packs this tab holds get another try.
    if (unshelved.length > 0) writeShelf(shelf);
    return;
  }
  const result = takeOff(kept);
  if (result === 'kept') console.error(`The pending pack shelf couldn't be cleared: the next load may add ${shelf.length - kept.length} stored pack(s) again.`);
  else if (result === 'others') console.error(`The pending pack shelf couldn't be rewritten: ${kept.length} owed pack(s) dropped (the history still has them).`);
  else if (result === 'gone') console.error(`The pending pack shelf couldn't be rewritten: ${kept.length} owed pack(s) dropped (the history still has them); another player's owed packs are kept in this tab till the shelf can be written.`);
};

/** Whether this player's pending shelf holds this pack (not the older builds' one-pack entry). */
export const onShelf = (nonce: number): boolean => readShelf().some((p) => p.n === nonce);

/**
 * The packs opened but never added to the collection (this player's only), taken off the shelf; other
 * players' packs stay on it. A pack in the older builds' entry stays there until clearPendingPack (see above).
 */
export const takePendingPacks = (): OpenedPack[] => {
  const legacy = readLegacy();
  const listed = readShelf();
  // If they can't be taken off the shelf, adding them now would add them again on the next load. With
  // none of this player's listed, a shelf holding another player's packs is left as it is.
  if (listed.length > 0 || readOthers().length === 0) {
    const result = takeOff([]);
    if (result === 'kept') return [];
    if (result === 'gone') console.error("The pending pack shelf couldn't be rewritten: another player's owed packs are kept in this tab till the shelf can be written.");
  }
  const packs: OpenedPack[] = [];
  for (const pending of [...legacy, ...listed]) {
    // One pack in both places is added once, and counts once if either copy says it has.
    const same = packs.find((p) => p.nonce === pending.n);
    if (same) {
      if (pending.d === 1) same.counted = true;
      continue;
    }
    const set = getSet(pending.s, pending.v);
    if (!set) continue;
    try {
      const cards = toCardsWithMeta(
        pending.c.split(',').map(decodeCard).map((c) => ({ setId: set.id, cardId: c.id, isHolo: c.holo, ...modifiersFor(c, set.modifiers === 1) })),
      ).map((c) => ({ ...c, isRevealed: true }));
      const flags = { ...(pending.d === 1 ? { counted: true } : {}), ...(legacy.includes(pending) ? { legacy: true } : {}) };
      packs.push({ setId: set.id, setVersion: set.version, nonce: pending.n, publicKeyHex: pending.k, cards, score: scoreCards(cards), openedAt: pending.t, ...flags });
    } catch { /* Unreadable: the history still has it. */ }
  }
  // An older build's entry with nothing to add (unreadable, or another player's) goes, as it did there.
  // If it can't, nothing is lost: the next load finds nothing to add in it either.
  if (!packs.some((p) => p.legacy)) removeLegacy();
  return packs;
};

/** Can this player share this pull? (False after importing a different player's key.) */
export const canShare = (ref: PullRef): boolean => !ref.publicKeyHex || getPlayer().publicKeyHex.startsWith(ref.publicKeyHex);

/** Sign a proof for one of this player's pulls (with their current name). */
export const proofFor = (ref: PullRef): string => {
  const player = getPlayer();
  if (!canShare(ref)) throw new Error('This pull was opened with a different player key, so this device cannot sign it.');
  return encodeProof(
    signProof({ setId: ref.setId, setVersion: ref.setVersion, publicKey: player.publicKey, nonce: ref.nonce, name: player.name }, player.secretKey),
  );
};

/**
 * A pull link. With a link-preview page (previewFor, or cardPreviewPath for one card), it goes
 * through that page (src/game/previewLinks.ts), so chat apps show the cards instead of the site.
 */
export const pullUrl = (proof: string, previewPage?: string): string =>
  `${window.location.origin}${import.meta.env.BASE_URL}${previewPage ?? ''}#/pull/${proof}`;

/** A pack's link-preview page: the cards that make its hand, or its best card. */
export const previewFor = (cards: readonly { key: string; rarity: Rarity; isHolo: boolean }[]): string | undefined => {
  const preview = previewOf(revealOrder(cards));
  return preview && previewPath(preview);
};

export interface CheckedPull extends VerifiedPull {
  cardsWithMeta: CardWithMeta[];
}

/**
 * Verify a shared pull on this device (ticket mined in the worker). It's optional work: its ticket
 * waits for any pack being opened, and `signal` stops it while it waits.
 */
export const checkPull = async (proof: string, signal?: AbortSignal): Promise<CheckedPull> => {
  const verified = await verifyProof(proof, getSet, (set, publicKey, nonce) => getTicket(set, publicKey, nonce, 'optional', signal));
  return { ...verified, cardsWithMeta: toCardsWithMeta(verified.cards).map((c) => ({ ...c, isRevealed: true })) };
};
