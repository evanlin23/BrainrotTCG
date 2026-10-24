// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSet } from '../content/sets';
import { packArtSettled } from './packArt';
import { prefetchNextPack } from './pulls';

const mined = vi.hoisted(() => Promise.resolve(new Uint8Array(32).fill(7)));
vi.mock('./ticketMiner', () => ({
  getTicket: () => mined,
  prefetchTicket: () => undefined,
}));

afterEach(() => vi.unstubAllGlobals());

describe('prefetchNextPack', () => {
  it("fetches the next pack's card pictures only once the sealed pack's art is in (#776)", async () => {
    const images: { src: string }[] = [];
    vi.stubGlobal('Image', class { src = ''; constructor() { images.push(this); } });
    prefetchNextPack(getSet('right-now', 2)!);
    // The ticket is in and the pack derived (its handler ran before this await resumes), but the pictures wait.
    await mined;
    expect(images).toEqual([]);

    packArtSettled();
    await Promise.resolve();
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((image) => image.src.length > 0)).toBe(true);
  });

  it("leaves the bandwidth to whatever covers the Open screen, and fetches once it's called uncovered (#762)", async () => {
    const images: { src: string }[] = [];
    vi.stubGlobal('Image', class { src = ''; constructor() { images.push(this); } });
    packArtSettled();
    prefetchNextPack(getSet('right-now', 2)!, true);
    await mined;
    await Promise.resolve();
    expect(images).toEqual([]);

    prefetchNextPack(getSet('right-now', 2)!, false);
    await mined;
    await Promise.resolve();
    expect(images.length).toBeGreaterThan(0);
  });

  it('fetches nothing once its caller has gone, whether that was before the ticket or the art came in', async () => {
    const images: { src: string }[] = [];
    vi.stubGlobal('Image', class { src = ''; constructor() { images.push(this); } });
    const beforeTicket = new AbortController();
    prefetchNextPack(getSet('right-now', 2)!, false, beforeTicket.signal);
    beforeTicket.abort();
    await mined;
    await Promise.resolve();
    expect(images).toEqual([]);

    // The art has settled (an earlier test settled it), so the pictures are a microtask behind the ticket.
    const beforeArt = new AbortController();
    prefetchNextPack(getSet('right-now', 2)!, false, beforeArt.signal);
    await mined;
    beforeArt.abort();
    await Promise.resolve();
    expect(images).toEqual([]);

    // A caller still there gets its pictures.
    prefetchNextPack(getSet('right-now', 2)!, false, new AbortController().signal);
    await mined;
    await Promise.resolve();
    expect(images.length).toBeGreaterThan(0);
  });
});
