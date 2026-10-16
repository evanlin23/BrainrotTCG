// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The load check runs once per module load, so each test imports a fresh copy.
let usePackHistory: typeof import('./usePackHistory').usePackHistory;
let enter: (inPack: boolean) => void = () => {};
let backs = 0;

const Probe = () => {
  const [inPack, setInPack] = useState(false);
  useEffect(() => {
    enter = setInPack;
  }, []);
  usePackHistory(inPack, () => {
    backs += 1;
    setInPack(false);
  });
  return null;
};

let root: Root | null = null;
const mount = () => act(() => {
  root = createRoot(document.createElement('div'));
  root.render(<Probe />);
});
const onPackEntry = () => !!(history.state as { brainrotPack?: boolean } | null)?.brainrotPack;
const setNavigation = (canGoBack: boolean) =>
  Object.defineProperty(window, 'navigation', { value: { canGoBack }, configurable: true });
/** jsdom delivers history traversal a task later. */
const settle = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  expect(check()).toBe(true);
};

/** Open a pack, then press Back: the pack has its own entry, so Back closes it. */
const packStillTakesBack = async () => {
  act(() => enter(true));
  expect(onPackEntry()).toBe(true);
  history.back();
  await settle(() => backs === 1);
  expect(onPackEntry()).toBe(false);
};

beforeEach(async () => {
  vi.resetModules();
  ({ usePackHistory } = await import('./usePackHistory'));
  backs = 0;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  delete (window as { navigation?: unknown }).navigation;
});

describe('usePackHistory on a page loaded on a stale pack entry', () => {
  // First, while this file's tab still has one entry.
  it('with nothing below it, unmarks it in place, so the next pack still adds its entry', async () => {
    expect(history.length).toBe(1);
    expect('navigation' in window).toBe(false);
    history.replaceState({ brainrotPack: true, kept: 1 }, '', '/BrainrotTCG/');
    const back = vi.spyOn(history, 'back');
    mount();
    expect(back).not.toHaveBeenCalled();
    expect(history.state).toEqual({ kept: 1 });
    await packStillTakesBack();
  });

  it('trusts the Navigation API when it says nothing of ours is below', async () => {
    history.pushState({ brainrotPack: true }, '', '/BrainrotTCG/');
    setNavigation(false);
    const back = vi.spyOn(history, 'back');
    mount();
    expect(back).not.toHaveBeenCalled();
    expect(onPackEntry()).toBe(false);
    await packStillTakesBack();
  });

  it('steps back over it when something is below, as before', async () => {
    history.pushState({}, '', '/BrainrotTCG/');
    history.pushState({ brainrotPack: true }, '');
    setNavigation(true);
    mount();
    await settle(() => !onPackEntry());
    await packStillTakesBack();
  });
});

describe('usePackHistory after an opener unmounts mid-pack', () => {
  it("doesn't read the old opener's step back as the player's Back when a new pack starts first", async () => {
    history.pushState({}, '', '/BrainrotTCG/');
    mount();
    act(() => enter(true));
    expect(onPackEntry()).toBe(true);
    act(() => root?.unmount());
    // The new opener's pack starts before the old one's step back has landed.
    mount();
    act(() => enter(true));
    // Let the old step back land, then add the new pack's own entry.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(backs).toBe(0);
    expect(onPackEntry()).toBe(true);
    // It holds an entry of its own, so Back still closes it.
    history.back();
    await settle(() => backs === 1);
    expect(onPackEntry()).toBe(false);
  });
});
