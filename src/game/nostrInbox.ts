/**
 * Hall of Fame submissions without a GitHub account, through public Nostr relays (NIP-01).
 *
 * The game signs a small event with a throwaway key (the pull proof inside carries the player's own
 * signature, so this key is only a transport) and posts it to several relays. A scheduled GitHub
 * Action (`scripts/hall-of-fame.ts inbox`) reads them, verifies each pull with the same engine, and
 * files the ones that qualify. Relays can drop an event, which is why there are several; they can't
 * forge a pull, because every entry is re-derived from its proof.
 *
 * Runs in the browser and in Node 22 (both have a global WebSocket).
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex, utf8 } from '../engine/bytes';
import { extractProof } from '../engine/proof';

/** Open public relays (no account, payment or proof-of-work, per their NIP-11 info). */
export const HOF_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub', 'wss://relay.nostr.net'];
/** NIP-78 application data: not a post, so it never shows up in anyone's feed. */
export const HOF_KIND = 30078;
export const HOF_TAG = 'brainrot-tcg-hall-of-fame';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

type Unsigned = Omit<NostrEvent, 'id' | 'sig'>;

/** NIP-01: sha256 of the serialized [0, pubkey, created_at, kind, tags, content]. */
export const eventId = (e: Unsigned): string => toHex(sha256(utf8(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));

export const signEvent = (e: Unsigned, secretKey: Uint8Array): NostrEvent => {
  const id = eventId(e);
  return { ...e, id, sig: toHex(schnorr.sign(fromHex(id), secretKey)) };
};

/**
 * Longest relay frame (JSON text) that gets parsed. strfry, which most of HOF_RELAYS run, caps an
 * event at 64 KiB by default; this leaves room for the frame around it and JSON escapes. A longer
 * frame is skipped unparsed (it still counts toward the relay's message budget).
 */
export const MAX_RAW_MESSAGE_CHARS = 131_072;

/**
 * What a Hall of Fame submission (or probe) needs, with room to spare: about 1 KB, three tags.
 * Bigger events are valid Nostr that honest relays serve, so they count as seen (for paging and the
 * relay's budget) but are skipped without hashing, verifying or keeping them.
 */
export const MAX_RETAINED_EVENT_BYTES = 4_096;
export const MAX_EVENT_TAGS = 16;
export const MAX_EVENT_TAG_ITEMS = 8;
/** NIP-01 created_at sanity limit (year ~2049). */
export const MAX_EVENT_TIMESTAMP = 2_500_000_000;

/** Most events a relay sends per request when the filter sets no `limit` (strfry's default cap). */
export const DEFAULT_PAGE_LIMIT = 500;

/** Malformed frames (not JSON, wrong types) tolerated from a relay before closing it. Honest relays send none. */
export const MAX_RELAY_INVALID_MESSAGES = 50;

const HEX64 = /^[0-9a-f]{64}$/;
/** NIP-01's field types. Relays don't all enforce them, so anything read from one is checked first. */
export const isEventShape = (e: unknown): e is NostrEvent => {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.id === 'string' && HEX64.test(x.id) &&
    typeof x.pubkey === 'string' && HEX64.test(x.pubkey) &&
    typeof x.sig === 'string' && /^[0-9a-f]{128}$/.test(x.sig) &&
    Number.isSafeInteger(x.created_at) && Number.isSafeInteger(x.kind) &&
    typeof x.content === 'string' &&
    Array.isArray(x.tags) && x.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
  );
};

/** Approximate size of an event in memory (its strings plus a little overhead). */
export const eventByteSize = (e: NostrEvent): number =>
  e.id.length + e.pubkey.length + e.sig.length + e.content.length +
  e.tags.reduce((sum, tag) => sum + tag.reduce((tSum, item) => tSum + item.length, 0), 0) +
  64;

/** Small enough to hash, verify and keep: what a Hall of Fame event needs (MAX_RETAINED_EVENT_BYTES). */
export const isRetainable = (e: NostrEvent): boolean =>
  e.created_at >= 0 && e.created_at <= MAX_EVENT_TIMESTAMP &&
  e.kind >= 0 && e.kind <= 65_535 &&
  e.tags.length <= MAX_EVENT_TAGS && e.tags.every((t) => t.length <= MAX_EVENT_TAG_ITEMS) &&
  eventByteSize(e) <= MAX_RETAINED_EVENT_BYTES;

/**
 * Cheap filter predicate applied before expensive hashing/signature verification.
 * Does not mutate the event.
 */
export const matchesFilter = (e: NostrEvent, f: Filter): boolean => {
  if (f.kinds?.length && !f.kinds.includes(e.kind)) return false;
  if (f.ids?.length && !f.ids.includes(e.id)) return false;
  if (f['#t']?.length && !e.tags.some((t) => t[0] === 't' && f['#t']!.includes(t[1]))) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  return true;
};

/** Whether `e.sig` is its pubkey's signature of `e.id` (not whether the id matches the content). */
const signatureVerifies = (e: NostrEvent): boolean => {
  try {
    return schnorr.verify(fromHex(e.sig), fromHex(e.id), fromHex(e.pubkey));
  } catch {
    return false;
  }
};

export const verifyEvent = (e: unknown): e is NostrEvent => isEventShape(e) && eventId(e) === e.id && signatureVerifies(e);

/**
 * A Hall of Fame submission for one pull, signed with a fresh throwaway key. `score` is the pull's
 * Brainrot Score as the player's device worked it out: a hint the inbox may use to turn a pull away
 * without re-deriving it (scripts/hof-inbox.ts). It never puts a pull on the list.
 */
export const hallOfFameEvent = (proof: string, pullId: string, now = Date.now(), score?: number): NostrEvent => {
  const secretKey = schnorr.utils.randomSecretKey();
  return signEvent(
    {
      pubkey: toHex(schnorr.getPublicKey(secretKey)),
      created_at: Math.floor(now / 1000),
      kind: HOF_KIND,
      tags: [
        ['d', `brainrot-tcg/hof/${pullId}`],
        ['t', HOF_TAG],
      ],
      content: JSON.stringify(score === undefined ? { v: 1, proof } : { v: 1, proof, score }),
    },
    secretKey,
  );
};

/**
 * A throwaway event to check that a relay stores and serves our events (`hall-of-fame.ts probe`).
 * It has its own tag, so the inbox never reads it, and asks relays to drop it after an hour (NIP-40).
 */
export const probeEvent = (now = Date.now()): NostrEvent => {
  const secretKey = schnorr.utils.randomSecretKey();
  const created = Math.floor(now / 1000);
  return signEvent(
    {
      pubkey: toHex(schnorr.getPublicKey(secretKey)),
      created_at: created,
      kind: HOF_KIND,
      tags: [
        ['d', `brainrot-tcg/probe/${created}`],
        ['t', 'brainrot-tcg-probe'],
        ['expiration', String(created + 3600)],
      ],
      content: '{}',
    },
    secretKey,
  );
};

/**
 * The proof inside a submission, or null if it isn't one. Only the exact text a pull link carries
 * counts (no padding or wrapping), so the proof can be written into a link and read back unchanged.
 */
export const proofFromEvent = (e: NostrEvent): string | null => {
  if (!isEventShape(e) || e.kind !== HOF_KIND || !e.tags.some((t) => t[0] === 't' && t[1] === HOF_TAG)) return null;
  try {
    const content = JSON.parse(e.content) as { v?: unknown; proof?: unknown };
    return content.v === 1 && typeof content.proof === 'string' && extractProof(content.proof) === content.proof ? content.proof : null;
  } catch {
    return null;
  }
};

/**
 * The score a submission claims for its pull, or null if it claims none (older clients) or the claim
 * isn't a whole number from 0 up. Untrusted: claiming too little only turns away the sender's own
 * pull, and a claim that lets a pull through is still verified in full.
 */
export const scoreHintFromEvent = (e: NostrEvent): number | null => {
  try {
    const { score } = JSON.parse(e.content) as { score?: unknown };
    return typeof score === 'number' && Number.isSafeInteger(score) && score >= 0 ? score : null;
  } catch {
    return null;
  }
};

type Socket = Pick<WebSocket, 'send' | 'close'> & {
  /** WebSocket.OPEN is 1; test sockets may leave it out. */
  readyState?: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
};
export type SocketFactory = (url: string) => Socket;
const defaultSocket: SocketFactory = (url) => new WebSocket(url) as unknown as Socket;

export interface PublishResult {
  relay: string;
  ok: boolean;
  message: string;
}

/** Send an event to one relay; it answers OK (accepted) or not, or times out. */
const publishToRelay = (event: NostrEvent, relay: string, timeoutMs: number, open: SocketFactory): Promise<PublishResult> =>
  new Promise<PublishResult>((resolve) => {
    let done = false;
    let socket: Socket | null = null;
    const finish = (ok: boolean, message: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      resolve({ relay, ok, message });
    };
    const timer = setTimeout(() => finish(false, 'timed out'), timeoutMs);
    try {
      socket = open(relay);
    } catch (error) {
      finish(false, String(error));
      return;
    }
    socket.onopen = () => socket!.send(JSON.stringify(['EVENT', event]));
    socket.onmessage = (msg) => {
      try {
        // Skip binary and oversized frames unread, like anything else that isn't our OK.
        if (typeof msg?.data !== 'string' || msg.data.length > MAX_RAW_MESSAGE_CHARS) return;
        const data = JSON.parse(msg.data) as unknown[];
        if (data[0] === 'OK' && data[1] === event.id) finish(data[2] === true, String(data[3] ?? ''));
      } catch {
        // ignore anything that isn't JSON
      }
    };
    socket.onerror = () => finish(false, 'connection failed');
    socket.onclose = () => finish(false, 'closed');
  });

/** Send an event to every relay at once; each answers OK (accepted) or not, or times out. */
export const publishEvent = (event: NostrEvent, relays = HOF_RELAYS, timeoutMs = 7000, open: SocketFactory = defaultSocket): Promise<PublishResult[]> =>
  Promise.all(relays.map((relay) => publishToRelay(event, relay, timeoutMs, open)));

/**
 * Send an event to every relay at once, but resolve as soon as one accepts it (the inbox reads every
 * relay, so one is enough). `accepted` is that relay's answer, or null once every relay has refused,
 * failed or timed out. The other sends carry on in the background; `all` settles when they finish.
 */
export const publishUntilAccepted = (
  event: NostrEvent,
  relays = HOF_RELAYS,
  timeoutMs = 7000,
  open: SocketFactory = defaultSocket,
): Promise<{ accepted: PublishResult | null; all: Promise<PublishResult[]> }> => {
  const sends = relays.map((relay) => publishToRelay(event, relay, timeoutMs, open));
  const all = Promise.all(sends);
  return new Promise((resolve) => {
    for (const send of sends) void send.then((result) => { if (result.ok) resolve({ accepted: result, all }); });
    void all.then(() => resolve({ accepted: null, all }));
  });
};

export interface Filter {
  ids?: string[];
  kinds: number[];
  '#t'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

/**
 * Limits on what fetchEvents takes from relays. The defaults fit an honest relay answering the
 * request (`limit` per page, `maxPages` pages), so only a relay sending more than it was asked for,
 * or malformed frames, runs into them.
 */
export interface FetchEventsBounds {
  /** Longest frame parsed; longer ones are skipped unread. */
  maxRawMessageChars?: number;
  /** Distinct well-formed events taken from one relay across all pages (kept or not). */
  maxRelayEvents?: number;
  /** Frames of any kind taken from one relay. */
  maxRelayMessages?: number;
  /** Malformed frames (not JSON, wrong types) taken from one relay. */
  maxInvalidMessages?: number;
  /** Events kept across all relays; each relay may add an equal share. */
  maxRetainedEvents?: number;
  /** Bytes of events kept across all relays (eventByteSize); each relay may add an equal share. */
  maxRetainedBytes?: number;
}

/** What fetchEvents read from one relay. */
export interface RelayRead {
  relay: string;
  /** Events the relay sent, counting repeats and ones skipped unread. */
  count: number;
  error?: string;
  /** The relay wasn't read to the end: everything newer than this second was (see fetchEvents). */
  more?: number;
  /** Seconds holding more events than a page, read past (newest first); some of their events weren't read. */
  crowded?: number[];
}

/**
 * The time an event frame too big to parse claims, read without parsing it: the largest
 * `"created_at":` number in it (only a key can hold one, since quotes in strings are escaped), so a
 * frame with extra fields can't claim an earlier time than its own. Infinity when there is none.
 */
export const oversizedEventTime = (raw: string): number => {
  let time = -Infinity;
  for (const m of raw.matchAll(/"created_at"\s*:\s*(\d{1,15})/g)) time = Math.max(time, Number(m[1]));
  return Number.isFinite(time) ? time : Infinity;
};

/**
 * Ask every relay for matching events and merge them by id. Only events whose signature checks out
 * are kept, so one relay serving a tampered copy can't hide the real one from the others. With
 * `lazySignatures`, an event is kept once its id matches its content (a cheap hash), and signatures
 * are checked only when relays send one event with different signatures, to keep a copy that
 * verifies; the caller then checks each event (verifyEvent) before trusting it, and pays only for
 * the ones it uses (a Schnorr check costs far more than the hash). Relays
 * send the newest `limit` events per request; with `maxPages` > 1 it keeps asking for older ones
 * (`until` the oldest so far), so a burst of new events can't push older ones out of reach. A relay
 * that didn't read to the end reports `more`: the `until` to go on from (everything newer than it was
 * read; some events at that second may not have been). That is a relay the page cap stopped while it
 * still had new events or a full page, and one that failed after finishing a page. A page whose
 * events all sit at its `until`, full or else all repeats, means more events share that second (which
 * the sender picks) than the relay sends at once, and `until` can't page into it: that second is
 * counted as read (and listed in `crowded` after a full page), and paging goes on from the second
 * before, so a crowd can't hide older events. Frames too big to parse still fill a
 * page, and the time they claim (oversizedEventTime) still moves paging on.
 *
 * Relays are untrusted, so each is held to `bounds`: frames are size-checked before parsing, events
 * bigger than a Hall of Fame event needs (isRetainable) or off the filter are skipped before any
 * hashing, and a relay that sends more than it was asked for, or keeps sending malformed frames, is
 * closed with an error naming the budget. Skipped events still count as seen, so paging carries on
 * past them. Each relay keeps to its own share of the retained budgets, so one can't crowd out the rest.
 */
export const fetchEvents = async (
  filter: Filter,
  relays = HOF_RELAYS,
  timeoutMs = 10000,
  open: SocketFactory = defaultSocket,
  maxPages = 1,
  signal?: AbortSignal,
  bounds: FetchEventsBounds = {},
  lazySignatures = false,
) => {
  const pageLimit = filter.limit ?? filter.ids?.length ?? DEFAULT_PAGE_LIMIT;
  const maxRelayEvents = bounds.maxRelayEvents ?? Math.max(1, pageLimit * maxPages);
  const maxInvalidMessages = bounds.maxInvalidMessages ?? MAX_RELAY_INVALID_MESSAGES;
  // Every event an honest relay may send, an EOSE per page, and room for NOTICEs and stragglers.
  const maxRelayMessages = bounds.maxRelayMessages ?? maxRelayEvents + maxPages + maxInvalidMessages + 100;
  const maxRawMessageChars = bounds.maxRawMessageChars ?? MAX_RAW_MESSAGE_CHARS;
  const relayCount = Math.max(1, relays.length);
  const maxRetainedEvents = bounds.maxRetainedEvents ?? maxRelayEvents * relayCount;
  const maxRetainedBytes = bounds.maxRetainedBytes ?? maxRetainedEvents * MAX_RETAINED_EVENT_BYTES;
  const relayEventShare = Math.ceil(maxRetainedEvents / relayCount);
  const relayByteShare = Math.ceil(maxRetainedBytes / relayCount);

  const byId = new Map<string, NostrEvent>();
  // With lazySignatures, ids whose kept copy is known to verify: other copies are ignored. Each relay
  // sends a copy of an event at most once, so a conflict costs at most one check per relay.
  const signed = new Set<string>();
  const perRelay = await Promise.all(
    relays.map(
      (relay) =>
        new Promise<RelayRead>((resolve) => {
          let sub = '';
          let count = 0;
          let pages = 0;
          let pageNew = 0;
          let pageEvents = 0;
          /** The oldest time an event on this page has, new or not. */
          let pageLow = Infinity;
          let oldest = Infinity;
          /** The `until` of the page being read (none for the first). */
          let asked: number | undefined;
          /** Seconds with more events than a page holds, read past (newest first). */
          const crowded: number[] = [];
          /** Where the pages finished so far reach down to, for a relay that fails partway. */
          let readTo: number | undefined;
          let messages = 0;
          let invalid = 0;
          let keptEvents = 0;
          let keptBytes = 0;
          const fromHere = new Set<string>();
          let done = false;
          let more: number | undefined;
          let socket: Socket | null = null;
          const finish = (error?: string) => {
            if (done) return;
            done = true;
            if (error !== undefined) more ??= readTo;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            try {
              // Only an open connection can take the goodbye (sending on a closed one logs an error).
              if (socket && (socket.readyState === undefined || socket.readyState === 1)) socket.send(JSON.stringify(['CLOSE', sub]));
            } catch {
              // already closed
            }
            try { socket?.close(); } catch { /* Already closed. */ }
            resolve({ relay, count, error, ...(more === undefined ? {} : { more }), ...(crowded.length ? { crowded } : {}) });
          };
          /** A frame no honest relay sends; too many of them closes the relay. */
          const malformed = () => {
            if (++invalid > maxInvalidMessages) finish('invalid message budget exceeded');
          };
          const request = (until?: number) => {
            sub = `hof-${Math.random().toString(36).slice(2, 10)}`;
            pages++;
            pageNew = 0;
            pageEvents = 0;
            pageLow = Infinity;
            asked = until;
            socket!.send(JSON.stringify(['REQ', sub, until === undefined ? filter : { ...filter, until }]));
          };
          const timer = setTimeout(() => finish('timed out'), timeoutMs);
          const onAbort = () => finish('aborted');
          if (signal?.aborted) {
            finish('aborted');
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
          try {
            socket = open(relay);
          } catch (error) {
            finish(String(error));
            return;
          }
          socket.onopen = () => { if (!done) request(); };
          socket.onmessage = (msg) => {
            if (done) return;
            if (++messages > maxRelayMessages) return finish('message budget exceeded');
            const raw = msg?.data;
            // NIP-01 is text frames only.
            if (typeof raw !== 'string') return malformed();
            // Relays may allow bigger events than we read; skip those unparsed. One for this request
            // still fills the page, and its time (see oversizedEventTime) still moves paging on, so a
            // page of them isn't taken for the end of the relay's history.
            if (raw.length > maxRawMessageChars) {
              if (!raw.slice(0, 64).startsWith(`["EVENT",${JSON.stringify(sub)},`)) return;
              count++;
              pageEvents++;
              const time = oversizedEventTime(raw);
              oldest = Math.min(oldest, time);
              pageLow = Math.min(pageLow, time);
              return;
            }
            let data: unknown;
            try {
              data = JSON.parse(raw);
            } catch {
              return malformed();
            }
            if (!Array.isArray(data) || typeof data[0] !== 'string') return malformed();
            // NOTICE, AUTH, other subscriptions' events and the like.
            if (data[1] !== sub) return;
            if (data[0] === 'EVENT') {
              const e: unknown = data[2];
              count++;
              pageEvents++;
              if (!isEventShape(e)) return malformed();
              pageLow = Math.min(pageLow, e.created_at);
              if (fromHere.has(e.id)) return;
              if (fromHere.size >= maxRelayEvents) return finish('relay event budget exceeded');
              fromHere.add(e.id);
              oldest = Math.min(oldest, e.created_at);
              pageNew++;
              // Seen, so paging goes on past it, but not worth hashing: too big for a Hall of Fame
              // event, or off the filter.
              if (!isRetainable(e) || !matchesFilter(e, filter)) return;
              const kept = byId.get(e.id);
              if (kept) {
                // Already kept from another relay. A copy with the same id has the same content, so
                // only its signature can differ: one that verifies takes the kept copy's place.
                if (!lazySignatures || signed.has(e.id) || e.sig === kept.sig) return;
                if (eventId(e) === e.id && signatureVerifies(e)) {
                  byId.set(e.id, e);
                  signed.add(e.id);
                }
                return;
              }
              const size = eventByteSize(e);
              if (keptEvents >= relayEventShare) return finish('retained event budget exceeded');
              if (keptBytes + size > relayByteShare) return finish('retained byte budget exceeded');
              if (lazySignatures ? eventId(e) === e.id : verifyEvent(e)) {
                byId.set(e.id, e);
                keptEvents++;
                keptBytes += size;
              }
            } else if (data[0] === 'EOSE') {
              // Where to go on from: the oldest time read, or this page's `until` after a crowd.
              const cursor = Math.min(oldest, asked ?? Infinity);
              // The page brought new events, or reached below its `until` (with events too big to read).
              const onward = pageNew > 0 || cursor < (asked ?? Infinity);
              const full = pageEvents >= pageLimit;
              // Every event on the page sits at its `until`: more share that second than the relay
              // will send at once (a full page, or a short page of repeats from a relay that caps
              // `limit` below ours), and asking `until` it again can't get past them, even from a
              // relay that serves them in a new order each time.
              const crowd = asked !== undefined && Number.isFinite(pageLow) && pageLow >= asked && (full || pageNew === 0);
              if (!Number.isFinite(cursor)) {
                // Nothing on the page has a time to page on from.
                finish(full ? 'a full page of events too big to read' : undefined);
              } else if (pages >= maxPages) {
                if (onward || full || crowd) more = cursor;
                finish();
              } else if (crowd || (full && !onward)) {
                // Count that second as read and go on from the second before, so a crowd (which the
                // sender picks) can't hide what is older. Only a full page names it: a short page of
                // repeats is also how an ordinary read ends, and the step past it then comes back empty.
                if (full) crowded.push(cursor);
                readTo = cursor - 1;
                if (filter.since !== undefined && cursor - 1 < filter.since) return finish();
                socket!.send(JSON.stringify(['CLOSE', sub]));
                request(cursor - 1);
              } else if (onward) {
                // Ask for anything older than this page until a page brings nothing new. (Relays cap
                // `limit` at different sizes, so a short page doesn't prove there's nothing older.)
                socket!.send(JSON.stringify(['CLOSE', sub]));
                readTo = cursor;
                request(cursor);
              } else {
                finish();
              }
            } else if (data[0] === 'CLOSED') {
              finish(String(data[2] ?? 'closed'));
            }
          };
          socket.onerror = () => finish('connection failed');
          socket.onclose = () => finish('closed');
        }),
    ),
  );
  return { events: [...byId.values()], perRelay };
};
