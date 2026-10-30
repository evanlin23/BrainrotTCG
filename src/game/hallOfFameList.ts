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
  /** How it was filed (see `provenanceText`); missing from snapshots published before it was. */
  submittedVia?: 'relay' | 'github';
  /** On the relays and checked on this device, but not filed yet (see `loadPending`). */
  pending?: boolean;
  /** A pending entry that this device sent itself: the only one the page calls "Just submitted". */
  mine?: boolean;
}

/**
 * Where an entry was submitted from, in plain words for the row's muted line. `submittedVia` is what
 * the deploy recorded: 'relay' for a pull the relay inbox's own bot filed, 'github' for one filed from
 * a GitHub account, whose issue author is `githubUser`. Neither says who the player is, so this never
 * names a login or calls anyone a verified GitHub user. Snapshots from before `submittedVia` was
 * published mark relay entries with the `githubUser` 'nostr' instead, and are read that way; a newer
 * entry is read only by its `submittedVia`, so a real GitHub user named `nostr` reads "via GitHub".
 * Returns null for a missing, 'unknown' or malformed value, and the row then says nothing.
 */
export const provenanceText = ({ githubUser, submittedVia }: { githubUser?: unknown; submittedVia?: unknown }): string | null => {
  if (submittedVia === 'relay' || (submittedVia === undefined && githubUser === 'nostr')) return 'via relay';
  if (submittedVia !== undefined && submittedVia !== 'github') return null;
  if (typeof githubUser !== 'string') return null;
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
let loadedAt = 0;
/** The last list that loaded, which a failed refetch falls back on. */
let lastLoaded: HallOfFameEntry[] | null = null;

/** A load that hasn't finished by then counts as failed, so the page can offer Retry again. */
export const LOAD_TIMEOUT_MS = 15_000;

/**
 * How long a loaded list is reused (here and by the rankings loaders in publishedRankings.ts). After
 * that the next caller fetches it again, so a tab left open picks up a new deploy, and with it a pull
 * a maintainer removed, the next time it shows the list.
 */
export const LIST_TTL_MS = 5 * 60_000;

/**
 * The published list, fetched at most once every five minutes; null if it has never loaded. A
 * refetch that fails keeps the last list that loaded, and the next call tries again.
 */
export const loadHallOfFame = (): Promise<HallOfFameEntry[] | null> => {
  if (loading && Date.now() - loadedAt < LIST_TTL_MS) return loading;
  loadedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  loading = fetch(`${import.meta.env.BASE_URL}hall-of-fame.json`, { cache: 'no-cache', signal: controller.signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: unknown) => (Array.isArray(data) ? data.map(withId) : null))
    .catch(() => null)
    .then((entries) => {
      clearTimeout(timeout);
      if (entries) return (lastLoaded = entries);
      loading = null;
      return lastLoaded;
    });
  return loading;
};

/** How long pending waits for the relays, and for the list of rejected pulls read beside them. */
const PENDING_TIMEOUT_MS = 5000;

/**
 * The pulls of issues a maintainer rejected (hall-of-fame-withdrawn.json, built next to the list).
 * They stay on the relays, so pending leaves them out. Null if the file couldn't be loaded.
 */
const loadWithdrawn = async (signal: AbortSignal): Promise<ReadonlySet<string> | null> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort);
  const timeout = setTimeout(abort, PENDING_TIMEOUT_MS);
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}hall-of-fame-withdrawn.json`, { cache: 'no-cache', signal: controller.signal });
    const data: unknown = res.ok ? await res.json() : null;
    return Array.isArray(data) && data.every((id) => typeof id === 'string') ? new Set(data) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
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
 * A pull a maintainer rejected is never pending, and if the list of those can't be loaded nothing
 * is: a removed pull must not come back because one file failed to load. Then it resolves to
 * 'unchecked' (when a relay could be read), so the page can say recent pulls couldn't be checked
 * rather than let the player's own vanish without a word.
 */
export const loadPending = async (published: readonly HallOfFameEntry[], onEntry: (entry: HallOfFameEntry) => void, signal: AbortSignal): Promise<boolean | 'unchecked'> => {
  const { fetchEvents, proofFromEvent, HOF_KIND, HOF_TAG } = await import('./nostrInbox');
  if (signal.aborted) return true;
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const [withdrawn, { events, perRelay }] = await Promise.all([
    loadWithdrawn(signal),
    fetchEvents({ kinds: [HOF_KIND], '#t': [HOF_TAG], since, limit: 100 }, undefined, PENDING_TIMEOUT_MS, undefined, 1, signal),
  ]);
  // An aborted read fails every relay too, but nobody is waiting on that answer.
  const reached = signal.aborted || events.length > 0 || perRelay.some((relay) => !relay.error);
  if (!withdrawn) return reached && !signal.aborted ? 'unchecked' : reached;
  const listed = new Set([...published.map((e) => e.id), ...withdrawn]);
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
        submittedVia: 'relay',
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

/** The last completed `loadPending` read and the published list it was made against (see `loadPendingCached`). */
let pendingRead: { published: readonly HallOfFameEntry[]; at: number; entries: HallOfFameEntry[] } | null = null;

/**
 * `loadPending` for a screen that opens again and again (the share sheet, from Packs, Profile and
 * achievements): a read that reached a relay and ran to the end is reused for as long as
 * `loadHallOfFame` reuses its list, so reopening costs no relay read and no tickets. The entries replay
 * to `onEntry` as they were; the read is still read-only, bounded and stopped by `signal`. A read that
 * was stopped, found every relay down or could not check (anything but `true`) is never kept, so the
 * next open tries again. A `true` read is kept as it is, even if only some relays answered or a pull
 * failed its check, as `loadPending` counts it. Rankings and the summary keep calling `loadPending`,
 * so a pull sent a moment ago still shows there at once.
 */
export const loadPendingCached = async (published: readonly HallOfFameEntry[], onEntry: (entry: HallOfFameEntry) => void, signal: AbortSignal): Promise<boolean | 'unchecked'> => {
  if (pendingRead && pendingRead.published === published && Date.now() - pendingRead.at < LIST_TTL_MS) {
    for (const entry of pendingRead.entries) if (!signal.aborted) onEntry(entry);
    return true;
  }
  const entries: HallOfFameEntry[] = [];
  const startedAt = Date.now();
  const result = await loadPending(published, (entry) => {
    entries.push(entry);
    onEntry(entry);
  }, signal);
  if (result === true && !signal.aborted) pendingRead = { published, at: startedAt, entries };
  return result;
};
