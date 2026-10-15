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
  recordPack(pack);
  savePendingPack(pack);
  return pack;
};

/*
 * The collection only takes a pack once its reveal is done (so achievements don't spoil it), but the
 * ticket is spent the moment it opens. Until the collection has it, the pack waits here, so a reload,
 * a closed tab or a dead phone mid-reveal can't lose it: the app adds it on the next load.
 */
interface PendingPack {
  s: string;
  v: number;
  n: number;
  k?: string;
  c: string;
  t: number;
}

/** Puts a pack (back) on the shelf; App does this when the collection holding it couldn't be stored. */
export const savePendingPack = (pack: OpenedPack) => {
  const pending: PendingPack = {
    s: pack.setId,
    v: pack.setVersion,
    n: pack.nonce,
    k: pack.publicKeyHex,
    c: pack.cards.map((c) => encodeCard({ id: c.id, holo: c.isHolo, finish: c.finish, misprint: c.misprint })).join(','),
    t: pack.openedAt,
  };
  try {
    localStorage.setItem(STORAGE_KEYS.PENDING_PACK, JSON.stringify(pending));
  } catch {
    // Out of space: the history still has it.
  }
};

/** Takes the pending pack off the shelf. False when storage refuses (a SecurityError), so it stays. */
const removePendingPack = (): boolean => {
  try {
    localStorage.removeItem(STORAGE_KEYS.PENDING_PACK);
    return true;
  } catch {
    return false;
  }
};

/** The collection has this pack now. */
export const clearPendingPack = (nonce: number) => {
  try {
    const pending = JSON.parse(localStorage.getItem(STORAGE_KEYS.PENDING_PACK) ?? 'null') as PendingPack | null;
    if (pending?.n === nonce) removePendingPack();
  } catch {
    removePendingPack();
  }
};

/** A pack opened but never added to the collection (this player's only), taken off the shelf. */
export const takePendingPack = (): OpenedPack | null => {
  let pending: PendingPack | null;
  try {
    pending = JSON.parse(localStorage.getItem(STORAGE_KEYS.PENDING_PACK) ?? 'null');
  } catch {
    pending = null;
  }
  // If it can't be taken off the shelf, adding it now would add it again on the next load.
  if (!removePendingPack()) return null;
  const set = pending && getSet(pending.s, pending.v);
  if (!pending || !set || (pending.k && pending.k !== getPlayer().publicKeyHex)) return null;
  try {
    const cards = toCardsWithMeta(
      pending.c.split(',').map(decodeCard).map((c) => ({ setId: set.id, cardId: c.id, isHolo: c.holo, ...modifiersFor(c, set.modifiers === 1) })),
    ).map((c) => ({ ...c, isRevealed: true }));
    return { setId: set.id, setVersion: set.version, nonce: pending.n, publicKeyHex: pending.k, cards, score: scoreCards(cards), openedAt: pending.t };
  } catch {
    return null;
  }
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

/** Verify a shared pull on this device (ticket mined in the worker). */
export const checkPull = async (proof: string): Promise<CheckedPull> => {
  const verified = await verifyProof(proof, getSet, getTicket);
  return { ...verified, cardsWithMeta: toCardsWithMeta(verified.cards).map((c) => ({ ...c, isRevealed: true })) };
};
