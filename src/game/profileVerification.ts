/**
 * Verifying someone else's shared profile (`#/profile/<proof>`): check it, re-open its packs on a
 * pool of workers, and check its claims. This is the public verifier's own module: it reads no
 * player, history, pack store or own-profile re-open job (reopenJob.ts), so verifying a shared
 * profile never touches or waits on your own save. What it shares is deliberate: the engine's
 * profile rules, the re-open cache (packs this device derived itself, keyed by set version), the
 * ticket pool, and optional-work admission, so it never runs a scheduler of its own.
 */
import {
  checkClaims,
  checkProfile,
  claimsTracker,
  openProfileTicket,
  ProofError,
  scorePulled,
  toHex,
  type CheckedProfile,
  type ProfilePack,
  type ProofRule,
} from '../engine';
import { getSet } from '../content/sets';
import { flushReopenCache, getReopened, putReopened } from './reopenCache';
import { createTicketPool, isMemoryError, OUT_OF_MEMORY_ADVICE } from './ticketPool';
import { admitOptional } from './admission';

export interface VerifyProfileOptions {
  /**
   * If true, only the profile's best packs (highlights) are re-opened. Once they are verified,
   * verification pauses so the shared profile viewer loads fast.
   */
  highlightsOnly?: boolean;
}

export interface ProfileProgress {
  checked: CheckedProfile;
  /** Packs re-opened so far, in ticket order. */
  packs: ProfilePack[];
  /** The packs the profile names as its best, once they're re-opened (they go first). */
  highlights: ProfilePack[] | null;
  /** Highlights have been re-opened and verified. */
  highlightsDone?: boolean;
  /** Every pack re-opened and the claims match. */
  done: boolean;
  /** Set when the profile turned out not to be real (rule "claims") or re-opening failed. */
  error?: { rule?: ProofRule; message: string };
}

/**
 * Counts verifyProfileLive calls: only the latest one may report. This assumes one profile viewer at
 * a time: a second caller running alongside would silently stop the first.
 */
let latestCheck = 0;

/**
 * Check a profile, then re-open its packs on a pool of workers, its claimed best packs first,
 * reporting as they finish; when every pack is in, check its claims. Packs this device has
 * re-opened before come from its cache. `checkProfile` errors (bad signature, unknown set, ...)
 * are thrown before anything is re-opened. A call stops reporting, and re-opening, once `signal`
 * aborts or a later call starts, so a pack that finishes late can't overwrite the newer check.
 */
export const verifyProfileLive = (
  text: string,
  onProgress: (p: ProfileProgress) => void,
  signal: AbortSignal,
  options?: VerifyProfileOptions,
): CheckedProfile => {
  const checked = checkProfile(text, getSet);
  const run = ++latestCheck;
  const current = () => run === latestCheck && !signal.aborted;
  const { profile, tickets } = checked;
  const total = tickets.length;
  const keyHex = toHex(profile.publicKey);
  const results: (ProfilePack | undefined)[] = new Array(total);
  const highlightsOnly = !!options?.highlightsOnly && profile.highlights.length < total;
  const order = highlightsOnly
    ? [...profile.highlights]
    : [...profile.highlights, ...Array.from({ length: total }, (_, n) => n).filter((n) => !profile.highlights.includes(n))];
  let pool: ReturnType<typeof createTicketPool> | null = null;
  let next = 0;
  let finished = 0;
  let lastReport = 0;
  // Made-up claims usually show long before the last pack: stop re-opening as soon as they do.
  const tracker = claimsTracker(profile, tickets);
  let ruledOut: string | null = tracker.initial();

  const snapshot = (extra: Partial<ProfileProgress> = {}): ProfileProgress => {
    const highlights = profile.highlights.map((n) => results[n]);
    return {
      checked,
      packs: results.filter((p): p is ProfilePack => !!p),
      highlights: highlights.every((p) => p) ? (highlights as ProfilePack[]) : null,
      done: false,
      ...extra,
    };
  };
  const report = (force = false) => {
    if (!current()) return;
    const now = performance.now();
    if (!force && now - lastReport < 150) return;
    lastReport = now;
    onProgress(snapshot());
  };

  const open = async (nonce: number) => {
    const set = tickets[nonce];
    const cached = getReopened(set, keyHex, nonce);
    if (cached) return { nonce, set, cards: cached, score: scorePulled(cached) };
    pool ??= createTicketPool();
    const { ticket } = pool;
    // Optional work: each ticket waits for a free slot, so opening a pack never waits behind it.
    const pack = await openProfileTicket(checked, nonce, (set, key, n) => admitOptional(() => ticket(set, key, n), signal));
    putReopened(set, keyHex, nonce, pack.cards);
    // Defensive. A page that has gone aborts first, which closes the pool and rejects the ticket still
    // pending, so none lands after it. One that does land once this check is no longer current (a later
    // call took over without an abort) still caches its pack, written now: the page took its own pending
    // write with it, so a batched one armed here would outlive it.
    if (!current()) flushReopenCache();
    return pack;
  };

  const work = async () => {
    while (current() && !ruledOut && next < order.length) {
      const nonce = order[next++];
      const pack = await open(nonce);
      results[nonce] = pack;
      finished++;
      ruledOut ??= tracker.add(pack);
      report(finished <= profile.highlights.length);
    }
  };

  signal.addEventListener('abort', () => pool?.close(), { once: true });
  const workers = Math.min(order.length, 8);
  Promise.all(Array.from({ length: workers }, work))
    .then(() => {
      if (!current()) return;
      if (ruledOut) {
        onProgress(snapshot({ error: { rule: 'claims', message: ruledOut } }));
        return;
      }
      if (highlightsOnly) {
        const highlights = profile.highlights.map((n) => results[n]);
        if (highlights.every((p) => p)) {
          onProgress(snapshot({ highlightsDone: true, done: false }));
          return;
        }
      }
      try {
        checkClaims(profile, results as ProfilePack[]);
        onProgress(snapshot({ highlightsDone: true, done: true }));
      } catch (error) {
        const rule = error instanceof ProofError ? error.rule : undefined;
        onProgress(snapshot({ error: { rule, message: error instanceof Error ? error.message : String(error) } }));
      }
    })
    .catch((error) => {
      if (!current()) return;
      // The browser's own words stay in the console; the viewer gets something to act on. Packs
      // re-opened so far are cached, so trying again carries on from where this stopped.
      console.error('Profile verification failed', error);
      const message = isMemoryError(error) ? OUT_OF_MEMORY_ADVICE : 'Something went wrong while re-opening the packs. Try again.';
      onProgress(snapshot({ error: { message } }));
    })
    .finally(() => pool?.close());
  report(true);
  return checked;
};
