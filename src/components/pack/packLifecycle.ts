import type { OpenedPack } from '../../game/pulls';
import type { PackRefusal } from './refusal';

/**
 * Where one pack is between the tear and the packs screen. Exactly one of these is true at a time; the
 * booleans the opener used to keep for it (torn, opening, summary, refused, left) could disagree.
 *
 * - sealed: on the packs screen, uncut. `refusal` is why the last tear opened nothing.
 * - tearing: cut, the ticket not spent yet. Leaving puts the pack back sealed.
 * - waiting: the ticket is spent and on its way. `leaving` is set once the player is gone (they pressed
 *   leave, or the opener unmounted): the pack is kept when it lands, not shown.
 * - revealing: the cards are being turned over. It holds the pack as dealt, so leaving (or unmounting) records
 *   it even before React has rendered the reveal.
 * - summary: every card is up and the pack is recorded.
 */
export type PackStage =
  | { kind: 'sealed'; refusal: PackRefusal | null }
  | { kind: 'tearing' }
  | { kind: 'waiting'; leaving: false | 'left' | 'unmounted' }
  | { kind: 'revealing'; pack: OpenedPack }
  | { kind: 'summary' };

export type PackEvent =
  /** A cut finished. */
  | { type: 'tear' }
  /** The pause after the tear is over: spend the ticket, unless the save changed under it. */
  | { type: 'spend'; blocked: boolean }
  /** The ticket arrived with its cards. */
  | { type: 'landed'; pack: OpenedPack }
  /** The ticket could not be had. */
  | { type: 'failed'; refusal: PackRefusal }
  /** The reveal reached its last card, or was skipped to it. */
  | { type: 'finish' }
  /** A tear was refused before it started. */
  | { type: 'refuse'; refusal: PackRefusal }
  /** The player backed out: the X, Escape or browser Back. */
  | { type: 'leave' }
  /** The player is done with the summary. */
  | { type: 'close' }
  /** The opener is gone. */
  | { type: 'unmount' };

export interface PackTransition {
  from: PackStage;
  /** The same object as `from` when the event changed nothing (it did not apply, or it came twice). */
  stage: PackStage;
  /**
   * The pack, as dealt, that goes to the collection now (the caller turns it face up): it just stopped being
   * revealed, or landed after the player left. Only these give it, so a pack is recorded once.
   */
  record: OpenedPack | null;
}

export const SEALED: PackStage = { kind: 'sealed', refusal: null };

const to = (from: PackStage, stage: PackStage, record: OpenedPack | null = null): PackTransition => ({ from, stage, record });

/** The next stage for an event; an event that does not fit the stage changes nothing. */
export const transition = (from: PackStage, event: PackEvent): PackTransition => {
  const same = to(from, from);
  switch (event.type) {
    case 'tear':
      return from.kind === 'sealed' ? to(from, { kind: 'tearing' }) : same;
    case 'spend':
      if (from.kind !== 'tearing') return same;
      return to(from, event.blocked ? { kind: 'sealed', refusal: 'blocked' } : { kind: 'waiting', leaving: false });
    case 'landed':
      if (from.kind !== 'waiting') return same;
      return from.leaving ? to(from, SEALED, event.pack) : to(from, { kind: 'revealing', pack: event.pack });
    case 'failed':
      if (from.kind !== 'waiting') return same;
      // Already back on the packs screen: nothing was dealt, so there is nothing to say.
      return to(from, from.leaving ? SEALED : { kind: 'sealed', refusal: event.refusal });
    case 'finish':
      return from.kind === 'revealing' ? to(from, { kind: 'summary' }, from.pack) : same;
    case 'refuse':
      return from.kind === 'sealed' ? to(from, { kind: 'sealed', refusal: event.refusal }) : same;
    case 'leave':
      switch (from.kind) {
        case 'sealed': return from.refusal ? to(from, SEALED) : same;
        case 'tearing': return to(from, SEALED);
        case 'waiting': return from.leaving ? same : to(from, { kind: 'waiting', leaving: 'left' });
        case 'revealing': return to(from, SEALED, from.pack);
        case 'summary': return to(from, SEALED);
      }
      return same;
    case 'close':
      return from.kind === 'summary' ? to(from, SEALED) : same;
    case 'unmount':
      // The stage is only changed where the pack would otherwise be lost: a ticket still on its way is kept
      // when it lands, and a reveal is recorded. (A reveal that goes on after this was a remount, which
      // finds the summary of a pack already recorded.)
      if (from.kind === 'waiting') return from.leaving ? same : to(from, { kind: 'waiting', leaving: 'unmounted' });
      return from.kind === 'revealing' ? to(from, { kind: 'summary' }, from.pack) : same;
  }
};
