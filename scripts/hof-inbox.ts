/**
 * The decision part of the Hall of Fame inbox (scripts/hall-of-fame.ts inbox), kept apart from
 * GitHub so it can be tested: which relay events become Hall of Fame entries.
 */
import { decodeProof, pullId, qualifiesForHallOfFame, verifyProof, type SetLookup, type TicketFn, type VerifiedPull } from '../src/engine/index.ts';
import { proofFromEvent, verifyEvent, type NostrEvent } from '../src/game/nostrInbox.ts';

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
 * breaks and other control characters (which could start a line with a `::workflow-command`) become
 * spaces, and it is cut to a readable length.
 */
const logSafeError = (error: unknown, max = 200): string => {
  const text = (error instanceof Error ? error.message : String(error)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ');
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
};

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
