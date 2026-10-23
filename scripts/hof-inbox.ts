/**
 * The decision part of the Hall of Fame inbox (scripts/hall-of-fame.ts inbox), kept apart from
 * GitHub so it can be tested: which relay events become Hall of Fame entries, and the log lines
 * that carry relay or issue text.
 */
import { decodeProof, isNameAllowed, pullId, qualifiesForHallOfFame, verifyProof, type PullProof, type SetLookup, type TicketFn, type VerifiedPull } from '../src/engine/index.ts';
import { proofFromEvent, scoreHintFromEvent, verifyEvent, type NostrEvent, type PublishResult } from '../src/game/nostrInbox.ts';

export interface InboxContext {
  /** Event ids already handled; updated as events are handled. */
  seen: Set<string>;
  /** Pull ids already in the Hall of Fame (any state); updated as entries are filed. */
  filed: Set<string>;
  /** How many pulls may be re-derived this run (about 0.1 s each). */
  budget: number;
  /** How many entries may be filed this run, so a burst of real pulls can't flood the issue tracker. */
  maxFiled: number;
  lookup: SetLookup;
  ticketFn?: TicketFn;
  /** Whether a verified pull goes in (default: it qualifies); the Hall of Fame also keeps a pull only if it would join the list. */
  accepts?: (pull: VerifiedPull) => boolean;
  /**
   * The score a pull must beat to join the list (`hallOfFameFloor`), or null while there's room. An
   * event whose score hint is at or below it is set aside without re-deriving it or spending budget.
   * The hint is the sender's claim: one that claims too little only loses its own pull, and one that
   * claims more is verified in full like any other. A function is asked again for each event, with
   * its pull id, so the floor can rise as pulls are filed and can differ from pull to pull.
   */
  floor?: number | null | ((id: string) => number | null);
  /** Files one verified, accepted pull. */
  file: (proof: string, pull: VerifiedPull, event: NostrEvent) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * An error's text made safe for one Actions log line. It can carry proof or relay content, so line
 * breaks (which could start a line with a `::workflow-command`) and control or invisible characters
 * become spaces, the legacy `##[command]` form (which the runner finds anywhere in a line, skipping
 * invisible characters) gets a space after the `##`, and it is cut to a readable length.
 */
export const logSafeError = (error: unknown, max = 200): string => {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]+/gu, ' ')
    .replace(/##\[/g, '## [');
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
};

/** The inbox's line for one relay; a relay's reason for closing the request is its own text. */
export const relayReadLine = (r: { relay: string; count: number; error?: string; more?: number }): string =>
  `${r.relay}: ${r.count} events${r.error ? ` (${logSafeError(r.error)})` : r.more !== undefined ? ', stopped at the page cap' : ''}`;

/** The inbox's line for reading one relay's older events, up to `until` (unix seconds). */
export const olderReadLine = (r: { relay: string; count: number; error?: string; more?: number }, until: number): string =>
  `${r.relay}: ${r.count} older events up to ${new Date(until * 1000).toISOString()}${r.error ? ` (${logSafeError(r.error)})` : r.more !== undefined ? ', stopped at the page cap' : ''}`;

/**
 * Inclusive ranges of event times (`created_at`, unix seconds), sorted and apart. The inbox keeps,
 * per relay, the ranges of its window it has read through and handled, so events past the page cap
 * are read by a later run instead of never.
 */
export type Ranges = [number, number][];

const mergeRanges = (ranges: Iterable<readonly [number, number]>): Ranges => {
  const merged: Ranges = [];
  for (const [lo, hi] of [...ranges].filter(([lo, hi]) => lo <= hi).sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
};

export const addRanges = (a: Ranges, b: Ranges): Ranges => mergeRanges([...a, ...b]);

export const clipRanges = (ranges: Ranges, lo: number, hi: number): Ranges => mergeRanges(ranges.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]));

/** The newest part of [lo, hi] that `read` doesn't cover. */
export const newestGap = (read: Ranges, lo: number, hi: number): [number, number] | undefined => {
  let top = hi;
  for (const [a, b] of [...clipRanges(read, lo, hi)].reverse()) {
    if (b < top) return [b + 1, top];
    top = a - 1;
  }
  return top >= lo ? [lo, top] : undefined;
};

/**
 * What one read of a relay covered, given the range it asked for: all of it, or from just above
 * where the page cap stopped it (`more`). A relay that failed counts as read nowhere.
 */
export const rangeRead = (r: { error?: string; more?: number }, lo: number, hi: number): Ranges =>
  r.error !== undefined ? [] : clipRanges([[r.more === undefined ? lo : r.more + 1, hi]], lo, hi);

/** The read ranges file: relay URL to ranges. Only the given relays and well-formed ranges are kept; anything else reads as nothing read. */
export const parseReadRanges = (text: string, relays: readonly string[]): Map<string, Ranges> => {
  const read = new Map<string, Ranges>();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return read;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return read;
  for (const relay of relays) {
    const ranges: unknown = (data as Record<string, unknown>)[relay];
    if (!Array.isArray(ranges)) continue;
    const ok = ranges.filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && r.every(Number.isSafeInteger));
    read.set(relay, mergeRanges(ok));
  }
  return read;
};

/** The order processInbox handles events in: oldest first. */
const handlingOrder = (events: readonly NostrEvent[]) => [...events].sort((a, b) => a.created_at - b.created_at);

/** The time of the first event processInbox left for the next run (`deferred` of them), or Infinity if it left none. */
export const deferredFrom = (events: readonly NostrEvent[], deferred: number): number =>
  deferred > 0 ? handlingOrder(events)[events.length - deferred].created_at : Infinity;

/** The probe's line for one relay; a relay's OK message and reason for closing are its own text. */
export const probeLine = (relay: string, sent: PublishResult, read: { count: number; error?: string }): string =>
  `${relay}: write ${sent.ok ? 'ok' : `failed (${logSafeError(sent.message)})`}, read ${read.count > 0 ? 'ok' : `failed (${logSafeError(read.error ?? 'not found')})`}`;

/** The deploy's line for a Hall of Fame issue it leaves out; the reason can quote the proof. */
export const buildSkipLine = (issue: number, reason: string): string => `#${issue}: skipped (${logSafeError(reason)})`;

/** Oldest first; each pull is filed at most once, and only if it verifies and qualifies. */
export const processInbox = async (events: readonly NostrEvent[], ctx: InboxContext): Promise<{ added: number; deferred: number }> => {
  let added = 0;
  let budget = ctx.budget;
  const ordered = handlingOrder(events);
  for (const [i, event] of ordered.entries()) {
    if (ctx.seen.has(event.id)) continue;
    const proof = verifyEvent(event) ? proofFromEvent(event) : null;
    let decoded: PullProof | null;
    let id: string | null;
    try {
      decoded = proof ? decodeProof(proof) : null;
      id = decoded ? pullId(decoded) : null;
    } catch {
      decoded = null;
      id = null;
    }
    if (!proof || !decoded || !id || ctx.filed.has(id)) {
      ctx.seen.add(event.id);
      continue;
    }
    // A blocked display name is never filed (see isNameAllowed), so its proof isn't worth checking.
    if (!isNameAllowed(decoded.name)) {
      ctx.seen.add(event.id);
      ctx.log?.(`${event.id}: display name isn't allowed; not filed`);
      continue;
    }
    const hint = scoreHintFromEvent(event);
    const floor = typeof ctx.floor === 'function' ? ctx.floor(id) : ctx.floor;
    if (floor != null && hint !== null && hint <= floor) {
      ctx.seen.add(event.id);
      ctx.log?.(`${event.id}: claims ${hint}, at or below the floor of ${floor}; not checked`);
      continue;
    }
    // The rest wait for the next run.
    if (added >= ctx.maxFiled || budget-- <= 0) return { added, deferred: ordered.length - i };
    ctx.seen.add(event.id);
    let pull: VerifiedPull;
    try {
      pull = await verifyProof(proof, ctx.lookup, ctx.ticketFn);
    } catch (error) {
      ctx.log?.(`${event.id}: didn't verify (${logSafeError(error)})`);
      continue;
    }
    if (!(ctx.accepts ? ctx.accepts(pull) : qualifiesForHallOfFame(pull.score))) {
      ctx.log?.(`${event.id}: ${pull.score.hand.name}, ${pull.score.score} doesn't make the Hall of Fame`);
      continue;
    }
    try {
      await ctx.file(proof, pull, event);
    } catch (error) {
      // GitHub hiccup: leave this event unhandled so the next run tries again, and stop for now.
      ctx.seen.delete(event.id);
      ctx.log?.(`${event.id}: couldn't file it (${logSafeError(error)}); will retry`);
      return { added, deferred: ordered.length - i };
    }
    ctx.filed.add(id);
    added++;
  }
  return { added, deferred: 0 };
};
