/**
 * The Profile's two highlights (#679, shown by #680): the best pack and the best card, each found from
 * what is already kept for it and each checked on its own with the engine.
 *
 * - Best pack: Stats.highestPackRef and highestPackCards, written when the pack opened (packProgress.ts).
 * - Best card: the first winner in the current key's Best cards list (bestCards.ts), which ranks and
 *   settles ties itself. It can come from a different pack than the best pack.
 *
 * Neither reads the pack history, the pack store or any other ticket: one pack is derived per source.
 * A source is `available` only once the engine re-derives its pack (derivePack) from the current
 * player's key and ticket and the exact cards (holo, finish, misprint) match what was kept; a cached
 * match alone is never enough. Nothing here writes storage, so a full or broken storage can't lose
 * progress, and a failed check keeps its source for a retry.
 */
import { getSet } from '../content/sets';
import { scoreCards } from '../data/cards';
import { cardPoints, derivePack, type PackScore, type PulledCard, type SetDefinition, type TicketFn } from '../engine';
import type { CardWithMeta } from '../components/cards/Card';
import type { Stats } from '../types';
import { getBestCards } from './bestCards';
import { encodeCard } from './cardCode';
import { getPlayer, getPlayerTickets, type Player } from './player';
import { toCardsWithMeta, type PullRef } from './pulls';
import { getTicket } from './ticketMiner';

/** A pull reference with the full 64-hex key it belongs to, so only that player can sign it (proofFor). */
export type OwnedPullRef = Required<PullRef>;

export interface BestPackSource {
  ref: OwnedPullRef;
  /** The cards kept when it opened (Stats.highestPackCards); may be empty in older saves. */
  cards: readonly CardWithMeta[];
  /** The Brainrot Score kept for it (Stats.highestPackFlexValue). */
  score: number;
}

export interface BestCardSource {
  ref: OwnedPullRef;
  /** Zero-based slot in engine pack order. */
  slot: number;
  /** The cached card, or null when this build couldn't score it: the check fills it from the engine. */
  card: PulledCard | null;
  points: number | null;
  /** Every ticket the key used was weighed (bestCards.ts), so this is the best of all of them, not just the recoverable ones. */
  complete: boolean;
}

export interface VerifiedBestPack {
  /** Re-derived by the engine, in engine order. */
  cards: CardWithMeta[];
  score: PackScore;
}

export interface VerifiedBestCard {
  card: CardWithMeta;
  pulled: PulledCard;
  points: number;
}

/**
 * - none: nothing recorded yet.
 * - legacy: a best pack that predates ticket references; it stays in Stats, shown unverified.
 * - other-player: kept for a different key than the current player's.
 * - unknown-set: this build doesn't have its set version.
 * - player-changed: the player changed while (or after) it was checked: retired, never certified.
 */
export type UnavailableReason = 'none' | 'legacy' | 'other-player' | 'unknown-set' | 'player-changed';

export type BestSourceState<S, V> =
  | { status: 'unavailable'; reason: UnavailableReason }
  | { status: 'checking'; source: S }
  | { status: 'available'; source: S; verified: V }
  /** mismatch: the engine's pack doesn't hold what was kept (no retry helps); error: the check itself failed (retry). */
  | { status: 'failed'; source: S; reason: 'mismatch' | 'error'; error?: unknown };

export type BestPackState = BestSourceState<BestPackSource, VerifiedBestPack>;
export type BestCardState = BestSourceState<BestCardSource, VerifiedBestCard>;

export interface BestSources {
  pack: BestPackState;
  card: BestCardState;
}

const FULL_KEY = /^[0-9a-f]{64}$/;

const unavailable = (reason: UnavailableReason) => ({ status: 'unavailable', reason }) as const;

/** A ref's key when it belongs to `player`: its own full key, or the player's when an older ref kept none or a prefix. */
const ownerOf = (ref: PullRef, player: Player): string | null =>
  !ref.publicKeyHex || player.publicKeyHex.startsWith(ref.publicKeyHex) ? player.publicKeyHex : null;

/** The best pack kept in `stats`, for the current player. Reads only `stats` and the player record. */
export const resolveBestPack = (stats: Stats, player: Player = getPlayer()): BestPackState => {
  const ref = stats.highestPackRef;
  if (!ref) return unavailable(stats.highestPackCards?.length || stats.highestPackLegacy ? 'legacy' : 'none');
  if (stats.highestPackLegacy) return unavailable('legacy');
  const owner = ownerOf(ref, player);
  if (!owner) return unavailable('other-player');
  if (!getSet(ref.setId, ref.setVersion)) return unavailable('unknown-set');
  return {
    status: 'checking',
    source: {
      ref: { setId: ref.setId, setVersion: ref.setVersion, nonce: ref.nonce, publicKeyHex: owner },
      cards: stats.highestPackCards ?? [],
      score: stats.highestPackFlexValue ?? 0,
    },
  };
};

/** The current player's strongest recorded card (bestCards.ts ranking and ties). Reads only the Best cards list and the player record. */
export const resolveBestCard = (snapshot: { player: Player; nextNonce: number } = getPlayerTickets()): BestCardState => {
  const { player, nextNonce } = snapshot;
  if (!FULL_KEY.test(player.publicKeyHex)) return unavailable('none');
  const { cards, complete } = getBestCards(player.publicKeyHex, nextNonce);
  const top = cards[0];
  if (!top) return unavailable('none');
  if (!getSet(top.setId, top.setVersion)) return unavailable('unknown-set');
  return {
    status: 'checking',
    source: {
      ref: { setId: top.setId, setVersion: top.setVersion, nonce: top.nonce, publicKeyHex: top.publicKeyHex },
      slot: top.slot,
      card: top.card,
      points: top.points,
      complete,
    },
  };
};

export interface CheckOptions {
  signal?: AbortSignal;
  /** Defaults to the shared miner's optional lane, so opening a pack always goes first. */
  ticketFn?: TicketFn;
}

const optionalTicket = (signal?: AbortSignal): TicketFn => (key, publicKey, nonce) => getTicket(key, publicKey, nonce, 'optional', signal);

const codeOf = (c: { isHolo: boolean; finish?: PulledCard['finish']; misprint?: boolean }, id: string) =>
  encodeCard({ id, holo: c.isHolo, finish: c.finish, misprint: c.misprint });

const sameCards = (kept: readonly CardWithMeta[], derived: readonly PulledCard[]) => {
  // Contents, not order: older saves may keep the pack in another order, and order doesn't score.
  const a = kept.map((c) => `${c.key}|${codeOf(c, c.id)}`).sort();
  const b = derived.map((c) => `${c.setId}/${c.cardId}|${codeOf(c, c.cardId)}`).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

/** The source's pack from the engine, checked against the player still being the one it belongs to. */
const derive = async (ref: OwnedPullRef, { signal, ticketFn }: CheckOptions): Promise<{ set: SetDefinition; cards: PulledCard[] } | 'player-changed'> => {
  const player = getPlayer();
  if (player.publicKeyHex !== ref.publicKeyHex) return 'player-changed';
  const set = getSet(ref.setId, ref.setVersion)!;
  const cards = await derivePack(set, player.publicKey, ref.nonce, ticketFn ?? optionalTicket(signal));
  // Imported or switched in another tab meanwhile: the result is that player's no more.
  if (getPlayer().publicKeyHex !== ref.publicKeyHex) return 'player-changed';
  signal?.throwIfAborted();
  return { set, cards };
};

/** Runs a check: a thrown error is a failed check that keeps its source, except an abort, which rejects. */
const checked = async <S extends { ref: OwnedPullRef }, V>(
  source: S,
  options: CheckOptions,
  judge: (set: SetDefinition, cards: PulledCard[]) => V | null,
): Promise<BestSourceState<S, V>> => {
  try {
    const derived = await derive(source.ref, options);
    if (derived === 'player-changed') return unavailable('player-changed');
    const verified = judge(derived.set, derived.cards);
    return verified ? { status: 'available', source, verified } : { status: 'failed', source, reason: 'mismatch' };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { status: 'failed', source, reason: 'error', error };
  }
};

/** Checks the best pack with the engine: the kept cards, exactly (holo, finish, misprint). Rejects only when `signal` aborts. */
export const checkBestPack = (source: BestPackSource, options: CheckOptions = {}): Promise<BestPackState> =>
  checked(source, options, (set, pulled) => {
    const cards = toCardsWithMeta(pulled, set).map((c) => ({ ...c, isRevealed: true }));
    const score = scoreCards(cards);
    // Older saves kept no cards: then the kept score must be the engine's.
    const matches = source.cards.length ? sameCards(source.cards, pulled) : source.score > 0 && score.score === source.score;
    return matches ? { cards, score } : null;
  });

/**
 * Checks the best card with the engine: that exact instance (slot, holo, finish, misprint), never
 * another copy or variant (#654). Rejects only when `signal` aborts.
 */
export const checkBestCard = (source: BestCardSource, options: CheckOptions = {}): Promise<BestCardState> =>
  checked(source, options, (set, cards) => {
    const pulled = cards.find((c) => c.slot === source.slot);
    const kept = source.card;
    if (!pulled || (kept && `${kept.setId}/${codeOf(kept, kept.cardId)}` !== `${pulled.setId}/${codeOf(pulled, pulled.cardId)}`)) return null;
    const [card] = toCardsWithMeta([pulled], set).map((c) => ({ ...c, isRevealed: true }));
    return { card, pulled, points: cardPoints(pulled.rarity, pulled.isHolo, pulled.finish, pulled.misprint) };
  });

/**
 * A state as it stands for the player now: one found or checked for another key is retired, so a
 * stale badge never shows (or signs) after an import or a switch in another tab (#653).
 */
export const forCurrentPlayer = <S extends { ref: OwnedPullRef }, V>(state: BestSourceState<S, V>, player: Player = getPlayer()): BestSourceState<S, V> =>
  'source' in state && state.source.ref.publicKeyHex !== player.publicKeyHex ? unavailable('player-changed') : state;

/**
 * Both highlights: found at once (`checking` or `unavailable`), then each checked on its own, so one
 * failing or still deriving never holds back or blanks the other. `onChange` gets every step; the
 * result is the settled pair. After `signal` aborts, nothing more is reported.
 */
export const checkBestSources = async (
  stats: Stats,
  onChange: (sources: BestSources) => void,
  options: CheckOptions = {},
): Promise<BestSources> => {
  const snapshot = getPlayerTickets();
  const sources: BestSources = { pack: resolveBestPack(stats, snapshot.player), card: resolveBestCard(snapshot) };
  const report = () => {
    if (!options.signal?.aborted) onChange({ ...sources });
  };
  report();
  const run = async <K extends keyof BestSources>(key: K, check: () => Promise<BestSources[K]>) => {
    try {
      sources[key] = await check();
      report();
    } catch {
      // Aborted: the caller has moved on.
    }
  };
  const { pack, card } = sources;
  await Promise.all([
    pack.status === 'checking' ? run('pack', () => checkBestPack(pack.source, options)) : undefined,
    card.status === 'checking' ? run('card', () => checkBestCard(card.source, options)) : undefined,
  ]);
  return { ...sources };
};

