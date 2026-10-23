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

  it('leaves the bandwidth to a shared pull until the Open screen shows (#762)', async () => {
    const images: { src: string }[] = [];
    vi.stubGlobal('Image', class { src = ''; constructor() { images.push(this); } });
    history.replaceState(null, '', '#/pull/some-proof');
    packArtSettled();
    prefetchNextPack(getSet('right-now', 2)!);
    await mined;
    await Promise.resolve();
    expect(images).toEqual([]);

    // Another page is no better: its cards are on screen too.
    history.replaceState(null, '', '#/rankings');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(images).toEqual([]);

    history.replaceState(null, '', location.pathname);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(images.length).toBeGreaterThan(0);
    const fetched = images.length;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(images).toHaveLength(fetched);
  });
});
