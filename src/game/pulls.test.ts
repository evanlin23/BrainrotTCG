import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { encodeCard } from './cardCode';
import { clearPendingPack, takePendingPack } from './pulls';

// A storage whose removeItem can be refused, as a browser that blocks storage (SecurityError) does.
const data = new Map<string, string>();
let refuseRemove = false;
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => {
    if (refuseRemove) throw new DOMException('Denied', 'SecurityError');
    data.delete(k);
  },
});

const SET = getSet('right-now', 2)!;
const PENDING = JSON.stringify({
  s: SET.id, v: SET.version, n: 4, c: SET.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(','), t: 1,
});

describe('pending pack when storage refuses to remove it', () => {
  beforeEach(() => {
    data.clear();
    refuseRemove = false;
  });

  it('leaves the pack for a later load instead of adding it now and again then', () => {
    data.set(STORAGE_KEYS.PENDING_PACK, PENDING);
    refuseRemove = true;
    expect(takePendingPack()).toBeNull();
    expect(data.get(STORAGE_KEYS.PENDING_PACK)).toBe(PENDING);

    refuseRemove = false;
    expect(takePendingPack()).toMatchObject({ setId: SET.id, nonce: 4, cards: expect.any(Array) });
    expect(data.has(STORAGE_KEYS.PENDING_PACK)).toBe(false);
  });

  it('clearing it does not throw, whether the entry is readable or not', () => {
    refuseRemove = true;
    data.set(STORAGE_KEYS.PENDING_PACK, PENDING);
    expect(() => clearPendingPack(4)).not.toThrow();
    data.set(STORAGE_KEYS.PENDING_PACK, '{not json');
    expect(() => clearPendingPack(4)).not.toThrow();
  });
});
