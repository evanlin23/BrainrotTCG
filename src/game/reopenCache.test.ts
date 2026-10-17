import { describe, expect, it, vi } from 'vitest';
import { getSet } from '../content/sets';
import { encodeCard } from './cardCode';
import { getReopened } from './reopenCache';

const data = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
});

describe('reopenCache', () => {
  it('still reads entries saved under `${id}@${version}|${public key}|${nonce}`', () => {
    const set = getSet('genesis', 1)!;
    const key = 'ab'.repeat(32);
    const card = set.cards[0];
    data.set('brainrot-reopened-v1', JSON.stringify({ [`genesis@1|${key}|7`]: encodeCard({ id: card.id, holo: true }) }));
    expect(getReopened(set, key, 7)).toEqual([{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: true, slot: 0 }]);
  });
});
