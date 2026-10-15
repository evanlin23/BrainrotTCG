/**
 * The decision part of the Hall of Fame inbox (scripts/hall-of-fame.ts inbox), kept apart from
 * GitHub so it can be tested: which relay events become Hall of Fame entries, and the log lines
 * that carry relay or issue text.
 */
import { decodeProof, pullId, qualifiesForHallOfFame, verifyProof, type SetLookup, type TicketFn, type VerifiedPull } from '../src/engine/index.ts';
import { proofFromEvent, verifyEvent, type NostrEvent, type PublishResult } from '../src/game/nostrInbox.ts';

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
  for (const [i, event] of ordered.entries()) {
    if (ctx.seen.has(event.id)) continue;
    const proof = verifyEvent(event) ? proofFromEvent(event) : null;
    let id: string | null = null;
    try {
      id = proof ? pullId(decodeProof(proof)) : null;
    } catch {
      id = null;
    }
    if (!proof || !id || ctx.filed.has(id)) {
      ctx.seen.add(event.id);
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
