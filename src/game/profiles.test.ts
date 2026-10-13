import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { checkProfile, computeTicket, derivePack, toHex } from '../engine';
import { encodeCard } from './cardCode';
import { getStoredPack, putStoredPacks, resetPackStore } from './packStore';
import { getHistory } from './history';
import { getPlayer } from './player';
import { myProfileInfo, myProfileProof, onReopenProgress, reopenMyPacks, resumeReopening } from './profiles';

// No Worker or IndexedDB here: tickets are mined on this thread and the pack store stays in memory.
const data = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
});

const SECRET = '01'.repeat(32);
const PENDING = 'brainrot-reopen-pending-v1';
const SET = getSet('right-now', 2)!;

/** A player who has used `count` tickets, all in the history without their cards (as after a big import). */
const setUp = (count: number) => {
  data.clear();
  resetPackStore();
  data.set('brainrot-player-v1', JSON.stringify({ secretKey: SECRET, name: 'Tester', nextNonce: count, createdAt: 0 }));
  const key = getPlayer().publicKeyHex.slice(0, 16);
  const history = Array.from({ length: count }, (_, n) => ({ s: SET.id, v: SET.version, n, k: key, h: 'No Matches', x: 0, t: count - n }));
  data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
};

const codeOf = async (nonce: number) =>
  (await derivePack(SET, getPlayer().publicKey, nonce, computeTicket))
    .map((c) => encodeCard({ id: c.cardId, holo: c.isHolo, finish: c.finish, misprint: c.misprint }))
    .join(',');

describe('re-opening your packs', () => {
  beforeEach(() => setUp(3));

  it('counts packs the store has as known', async () => {
    expect(myProfileInfo()).toMatchObject({ packs: 3, missing: 3 });
    const player = getPlayer();
    await putStoredPacks([{ setKey: 'right-now@2', publicKeyHex: player.publicKeyHex, nonce: 1, cards: await codeOf(1) }]);
    expect(myProfileInfo()).toMatchObject({ packs: 3, missing: 2 });
  });

  it('re-opens every missing pack, keeps them, reports progress and clears the resume flag', async () => {
    const seen: number[] = [];
    const stop = onReopenProgress((s) => seen.push(s.done));
    await reopenMyPacks();
    stop();
    const player = getPlayer();
    for (const n of [0, 1, 2]) expect(getStoredPack('right-now@2', player.publicKeyHex, n)).toBe(await codeOf(n));
    expect(myProfileInfo()).toMatchObject({ missing: 0 });
    expect(seen[seen.length - 1]).toBe(3);
    expect(data.has(PENDING)).toBe(false);
    // The history shows them too, though its own record still has no cards.
    expect(getHistory().every((e) => e.cards?.length === 5)).toBe(true);
    expect(data.get(STORAGE_KEYS.HISTORY)).not.toContain('"c"');
  }, 30_000);

  it('signs a profile that verifies, from re-opened packs', async () => {
    const proof = await myProfileProof();
    const checked = checkProfile(proof!, getSet);
    expect(toHex(checked.profile.publicKey)).toBe(getPlayer().publicKeyHex);
    expect(checked.tickets).toHaveLength(3);
  }, 30_000);

  it("resumes an unfinished run on load, but only for the player who started it", async () => {
    data.set(PENDING, 'ff'.repeat(32));
    resumeReopening();
    expect(data.has(PENDING)).toBe(false);
    expect(myProfileInfo()).toMatchObject({ missing: 3 });

    data.set(PENDING, getPlayer().publicKeyHex);
    resumeReopening();
    await reopenMyPacks(); // joins the resumed run
    expect(myProfileInfo()).toMatchObject({ missing: 0 });
  }, 30_000);
});
