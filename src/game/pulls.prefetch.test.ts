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
});
