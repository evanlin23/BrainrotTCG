/**
 * The published Hall of Fame (public/hall-of-fame.json, built by scripts/hall-of-fame.ts during
 * deploy): the top pulls and the daily tops of the last two UTC days. The page shows the published
 * entries as built, and re-checks only the pending ones it reads from the relays (`loadPending`).
 */
import { decodeProof, hallOfFameJoin, isNameAllowed, pullId, utcDay, type Finish, type RankableEntry } from '../engine';
import { checkPull } from './pulls';
import { wasSubmitted } from './share';

export interface HallOfFameEntry extends RankableEntry {
  proof: string;
  name: string;
  fingerprint: string;
  setName: string;
  /** finish and misprint only for cards from sets with modifiers. */
  cards: { cardId: string; isHolo: boolean; finish?: Finish | null; misprint?: boolean }[];
  issue: number;
  githubUser: string;
  /** On the relays and checked on this device, but not filed yet (see `loadPending`). */
  pending?: boolean;
  /** A pending entry that this device sent itself: the only one the page calls "Just submitted". */
  mine?: boolean;
}

/**
 * Where an entry was submitted from, in plain words for the row's muted line. `githubUser` is the
 * issue author as the deploy recorded it, and 'nostr' marks the relay inbox's own bot filing the
 * issue: neither says who the player is, so this never names a login or calls anyone a verified
 * GitHub user. A real GitHub user named `nostr` collides with the relay marker (the build passes
 * the login through as is); that is fixed in a later slice. Returns null for a missing, 'unknown' or malformed value, and the row then says nothing.
 */
export const provenanceText = (githubUser: unknown): string | null => {
  if (typeof githubUser !== 'string') return null;
  if (githubUser === 'nostr') return 'via relay';
  // A GitHub login: letters, digits and single hyphens, up to 39 characters.
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(githubUser) && githubUser !== 'unknown' ? 'via GitHub' : null;
};

/** Entries from before ids were published get theirs from the proof (a bad proof keys on its text). */
const withId = (entry: Omit<HallOfFameEntry, 'id'> & { id?: unknown }): HallOfFameEntry => {
  if (typeof entry.id === 'string') return entry as HallOfFameEntry;
  let id = entry.proof;
  try {
    id = pullId(decodeProof(entry.proof));
  } catch {
    // fails verification on the page and shows as such
  }
  return { ...entry, id };
};

let loading: Promise<HallOfFameEntry[] | null> | null = null;

/** A load that hasn't finished by then counts as failed, so the page can offer Retry again. */
export const LOAD_TIMEOUT_MS = 15_000;

/** The published list, fetched once per visit; null if it couldn't be loaded. */
export const loadHallOfFame = (): Promise<HallOfFameEntry[] | null> => {
  if (loading) return loading;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  loading = fetch(`${import.meta.env.BASE_URL}hall-of-fame.json`, { cache: 'no-cache', signal: controller.signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: unknown) => (Array.isArray(data) ? data.map(withId) : null))
    .catch(() => null)
    .then((entries) => {
      clearTimeout(timeout);
      if (entries === null) loading = null;
      return entries;
    });
  return loading;
};

/** How many unfiled submissions one visit checks (a ticket each), newest first after your own. */
const PENDING_LIMIT = 10;

/**
 * Submissions sent in the last week that aren't in the published list yet. The GitHub job files them
 * for good on a schedule, which GitHub can delay; meanwhile every visitor reads the relays and checks
 * them on their own device, so a pull shows as soon as it's sent. Each one that would join the list
 * is handed to `onEntry` as it's checked. One that would only join today's top (UTC) counts only if
 * it was sent today: a daily pull leaves the published list after about two days, and an older
 * event must not come back as today's. Resolves to whether any relay could be read: false when every
 * one failed, so the page can say the live feed is down rather than let that look like an empty board.
 */
export const loadPending = async (published: readonly HallOfFameEntry[], onEntry: (entry: HallOfFameEntry) => void, signal: AbortSignal): Promise<boolean> => {
  const { fetchEvents, proofFromEvent, HOF_KIND, HOF_TAG } = await import('./nostrInbox');
  if (signal.aborted) return true;
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const { events, perRelay } = await fetchEvents({ kinds: [HOF_KIND], '#t': [HOF_TAG], since, limit: 100 }, undefined, 5000, undefined, 1, signal);
  // An aborted read fails every relay too, but nobody is waiting on that answer.
  const reached = signal.aborted || events.length > 0 || perRelay.some((relay) => !relay.error);
  const listed = new Set(published.map((e) => e.id));
  const seen = new Set<string>();
  const candidates = events
    .sort((a, b) => b.created_at - a.created_at)
    .flatMap((event) => {
      const proof = proofFromEvent(event);
      if (!proof) return [];
      try {
        const decoded = decodeProof(proof);
        // The inbox never files a pull whose display name isn't allowed, so it is never pending either.
        if (!isNameAllowed(decoded.name)) return [];
        const id = pullId(decoded);
        if (listed.has(id) || seen.has(id)) return [];
        seen.add(id);
        return [{ event, proof, id, mine: wasSubmitted(id) }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => Number(b.mine) - Number(a.mine))
    .slice(0, PENDING_LIMIT);

  const list: RankableEntry[] = [...published];
  const today = utcDay(new Date().toISOString());
  const todayStart = Date.parse(`${today}T00:00:00.000Z`) / 1000;
  // One at a time: tickets mine one after another anyway, and starting the next check early saved
  // little and added main-thread work (measured in #777, docs/DEVELOPMENT.md).
  for (const [i, { event, proof, id, mine }] of candidates.entries()) {
    if (signal.aborted) return true;
    try {
      const pull = await checkPull(proof, signal);
      // The same test the inbox applies before filing it: the top pulls or today's top (UTC).
      const join = hallOfFameJoin({ id, setId: pull.set.id, score: pull.score }, list, today);
      if (!join || (join === 'daily' && event.created_at < todayStart)) continue;
      const entry: HallOfFameEntry = {
        id,
        proof,
        name: pull.proof.name,
        fingerprint: pull.fingerprint,
        setId: pull.set.id,
        setName: pull.set.name,
        hand: pull.score.hand.name,
        multiplier: pull.score.hand.multiplier,
        score: pull.score.score,
        cards: pull.cards.map((c) => ({ cardId: c.cardId, isHolo: c.isHolo, ...(c.finish ? { finish: c.finish } : {}), ...(c.misprint ? { misprint: true } : {}) })),
        issue: -(i + 1), // not filed yet; negative so it never clashes with a real issue
        githubUser: 'nostr',
        // The event's own time is whatever the sender set, so it can't place this ahead of anything
        // already filed: it counts as now.
        submittedAt: new Date().toISOString(),
        pending: true,
        ...(mine ? { mine: true } : {}),
      };
      list.push(entry);
      if (!signal.aborted) onEntry(entry);
    } catch {
      // didn't verify: never shown
    }
  }
  return reached;
};
