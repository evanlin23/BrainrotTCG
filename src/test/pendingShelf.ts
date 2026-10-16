import { STORAGE_KEYS } from '../constants/config';

/** The pending shelf's entries in storage, one per pack (see game/pulls.ts). */
export const shelfKeys = (): string[] =>
  Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '').filter((k) => k.startsWith(STORAGE_KEYS.PENDING_PACK_PREFIX));

/** The packs on the pending shelf, any player's, by nonce (not the earlier builds' list or one-pack entry). */
export const shelvedPacks = (): { n: number; k?: string; d?: number }[] =>
  shelfKeys().map((k) => JSON.parse(localStorage.getItem(k)!) as { n: number; k?: string; d?: number }).sort((a, b) => a.n - b.n);
