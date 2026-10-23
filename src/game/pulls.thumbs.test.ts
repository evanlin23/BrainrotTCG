// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardFinishThumbUrl } from '../content/art';
import { getSet } from '../content/sets';
import { getCard } from '../data/cards';
import { generatePack, packSeedFromTicket } from '../engine';
import { prefetchNextPack } from './pulls';

const SET = getSet('right-now', 2)!;
/** The first ticket (by its first byte) whose pack has a finished card: packs are deterministic. */
const ticket = (() => {
  for (let n = 0; n < 256; n++) {
    const candidate = new Uint8Array(32).fill(n);
    if (generatePack(SET, packSeedFromTicket(candidate)).some((card) => card.finish)) return candidate;
  }
  throw new Error('No finished card in 256 packs');
})();
const mined = vi.hoisted(() => ({ ticket: Promise.resolve(new Uint8Array(32)) }));
vi.mock('./ticketMiner', () => ({ getTicket: () => mined.ticket, prefetchTicket: () => undefined }));

afterEach(() => vi.unstubAllGlobals());

describe('prefetchNextPack', () => {
  it("fetches the next pack's card art and, for a finished card, the thumbnail its summary tile shows (#620)", async () => {
    const images: { src: string }[] = [];
    vi.stubGlobal('Image', class { src = ''; constructor() { images.push(this); } });
    mined.ticket = Promise.resolve(ticket);
    prefetchNextPack(SET);
    // Its handler ran before this await resumes.
    await mined.ticket;
    const expected = generatePack(SET, packSeedFromTicket(ticket)).flatMap((card) => {
      const image = getCard(`${card.setId}/${card.cardId}`)!.image;
      return card.finish ? [image, cardFinishThumbUrl(image, card.finish)!] : [image];
    });
    // Five cards, and at least one thumbnail.
    expect(expected.length).toBeGreaterThan(5);
    expect(images.map((image) => image.src)).toEqual(expected);
  });
});
