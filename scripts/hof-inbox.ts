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
  /** Filled in for the run's summary (scripts/ops-health.ts): counts and the reason it stopped early. */
  stats?: InboxStats;
}

/** What a run did, for its counts-only summary. */
export interface InboxStats {
  /** Pulls re-derived. */
  checked: number;
  /** Why events were left for the next run: budget spent, filing cap reached, or a GitHub write failed. */
  stop: 'budget' | 'filing-cap' | 'write-failed' | null;
  /** The sender's timestamp (Unix seconds) of the oldest event left for later. */
  oldestDeferredAt: number | null;
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
export const relayReadLine = (r: { relay: string; count: number; error?: string }): string =>
  `${r.relay}: ${r.count} events${r.error ? ` (${logSafeError(r.error)})` : ''}`;

/** The probe's line for one relay; a relay's OK message and reason for closing are its own text. */
export const probeLine = (relay: string, sent: PublishResult, read: { count: number; error?: string }): string =>
  `${relay}: write ${sent.ok ? 'ok' : `failed (${logSafeError(sent.message)})`}, read ${read.count > 0 ? 'ok' : `failed (${logSafeError(read.error ?? 'not found')})`}`;

/** The deploy's line for a Hall of Fame issue it leaves out; the reason can quote the proof. */
export const buildSkipLine = (issue: number, reason: string): string => `#${issue}: skipped (${logSafeError(reason)})`;

/** Oldest first; each pull is filed at most once, and only if it verifies and qualifies. */
export const processInbox = async (events: readonly NostrEvent[], ctx: InboxContext): Promise<{ added: number; deferred: number }> => {
  let added = 0;
  let budget = ctx.budget;
  const ordered = [...events].sort((a, b) => a.created_at - b.created_at);
  const defer = (i: number, stop: InboxStats['stop']) => {
    if (ctx.stats) Object.assign(ctx.stats, { stop, oldestDeferredAt: ordered[i].created_at });
    return { added, deferred: ordered.length - i };
  };
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
    if (added >= ctx.maxFiled) return defer(i, 'filing-cap');
    if (budget-- <= 0) return defer(i, 'budget');
    ctx.seen.add(event.id);
    if (ctx.stats) ctx.stats.checked++;
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
      return defer(i, 'write-failed');
    }
    ctx.filed.add(id);
    added++;
  }
  return { added, deferred: 0 };
};
