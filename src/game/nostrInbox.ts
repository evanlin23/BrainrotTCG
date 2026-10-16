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

const HEX64 = /^[0-9a-f]{64}$/;
/** NIP-01's field types. Relays don't all enforce them, so anything read from one is checked first. */
const isEventShape = (e: unknown): e is NostrEvent => {
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

export const verifyEvent = (e: unknown): e is NostrEvent => {
  try {
    return isEventShape(e) && eventId(e) === e.id && schnorr.verify(fromHex(e.sig), fromHex(e.id), fromHex(e.pubkey));
  } catch {
    return false;
  }
};

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
        const data = JSON.parse(String(msg.data)) as unknown[];
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
 * Ask every relay for matching events and merge them by id. Only events whose signature checks out
 * are kept, so one relay serving a tampered copy can't hide the real one from the others. Relays
 * send the newest `limit` events per request; with `maxPages` > 1 it keeps asking for older ones
 * (`until` the oldest so far), so a burst of new events can't push older ones out of reach.
 */
export const fetchEvents = async (filter: Filter, relays = HOF_RELAYS, timeoutMs = 10000, open: SocketFactory = defaultSocket, maxPages = 1, signal?: AbortSignal) => {
  const byId = new Map<string, NostrEvent>();
  const perRelay = await Promise.all(
    relays.map(
      (relay) =>
        new Promise<{ relay: string; count: number; error?: string }>((resolve) => {
          let sub = '';
          let count = 0;
          let pages = 0;
          let pageNew = 0;
          let oldest = Infinity;
          const fromHere = new Set<string>();
          let done = false;
          let socket: Socket | null = null;
          const finish = (error?: string) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            try {
              // Only an open connection can take the goodbye (sending on a closed one logs an error).
              if (socket && (socket.readyState === undefined || socket.readyState === 1)) socket.send(JSON.stringify(['CLOSE', sub]));
            } catch {
              // already closed
            }
            try { socket?.close(); } catch { /* Already closed. */ }
            resolve({ relay, count, error });
          };
          const request = (until?: number) => {
            sub = `hof-${Math.random().toString(36).slice(2, 10)}`;
            pages++;
            pageNew = 0;
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
            try {
              const data = JSON.parse(String(msg.data)) as unknown[];
              if (data[0] === 'EVENT' && data[1] === sub) {
                const e = data[2];
                count++;
                if (isEventShape(e) && !fromHere.has(e.id)) {
                  fromHere.add(e.id);
                  oldest = Math.min(oldest, e.created_at);
                  pageNew++;
                  if (!byId.has(e.id) && verifyEvent(e)) byId.set(e.id, e);
                }
              } else if (data[0] === 'EOSE' && data[1] === sub) {
                // Ask for anything older than this page until a page brings nothing new. (Relays cap
                // `limit` at different sizes, so a short page doesn't prove there's nothing older.)
                if (pageNew > 0 && pages < maxPages && Number.isFinite(oldest)) {
                  socket!.send(JSON.stringify(['CLOSE', sub]));
                  request(oldest);
                } else finish();
              } else if (data[0] === 'CLOSED' && data[1] === sub) {
                finish(String(data[2] ?? 'closed'));
              }
            } catch {
              // ignore anything that isn't JSON
            }
          };
          socket.onerror = () => finish('connection failed');
          socket.onclose = () => finish('closed');
        }),
    ),
  );
  return { events: [...byId.values()], perRelay };
};
