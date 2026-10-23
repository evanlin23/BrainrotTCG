// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSet } from '../content/sets';
import { packArtSettled } from './packArt';
import { prefetchNextPack } from './pulls';
import { useRoute } from '../hooks/useRoute';

type Route = ReturnType<typeof useRoute>;

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

  it.each([
    ['a shared pull', '#/pull/some-proof', (route: Route) => route.closeLink()],
    ['another page', '#/rankings', (route: Route) => route.closePage()],
  ])('leaves the bandwidth to %s until the app moves to the Open screen (#762)', async (_, hash, close) => {
    const images: { src: string }[] = [];
    vi.stubGlobal('Image', class { src = ''; constructor() { images.push(this); } });
    let route!: Route;
    const Probe = () => {
      route = useRoute();
      return null;
    };
    history.replaceState(null, '', hash);
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Probe)));
    packArtSettled();
    prefetchNextPack(getSet('right-now', 2)!);
    await mined;
    await Promise.resolve();
    expect(images).toEqual([]);

    // The app's own moves use replaceState, which fires no hashchange: the route itself lets the art go.
    act(() => close(route));
    expect(location.hash).toBe('');
    expect(images.length).toBeGreaterThan(0);
    act(() => root.unmount());
  });
});
