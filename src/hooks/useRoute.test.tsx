// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HISTORY_ENTRY_EVENT } from '../game/route';
import { isBrokenLink, useRoute } from './useRoute';

const PROFILE_ID = 'a'.repeat(120);

describe('isBrokenLink', () => {
  it.each([
    ['#/profile', false],
    ['#/cards', false],
    ['#/settings', false],
    ['', false],
    [`#/profile/${PROFILE_ID}`, false],
    ['#/profile/', true],
    ['#/profile/abc', true],
    ['#/pull/abc', true],
  ])('%s -> %s', (hash, broken) => {
    expect(isBrokenLink(hash)).toBe(broken);
  });
});

let current: ReturnType<typeof useRoute>;
const Probe = () => {
  const route = useRoute();
  useEffect(() => { current = route; });
  return null;
};

let root: Root | null = null;
const mount = (url: string, state: unknown = null) => {
  history.replaceState(state, '', url);
  act(() => {
    root = createRoot(document.createElement('div'));
    root.render(<Probe />);
  });
};
/**
 * jsdom delivers history traversal and hash navigation a task later: popstate, then hashchange when the
 * hash differs, back to back. Resolves once the next of them has fired.
 */
const nextNavigation = () => act(() => new Promise<void>((resolve) => {
  const done = () => {
    window.removeEventListener('popstate', done);
    window.removeEventListener('hashchange', done);
    resolve();
  };
  window.addEventListener('popstate', done);
  window.addEventListener('hashchange', done);
}));
/** Waits for the one navigation the condition needs (the hook's own listeners run first), unless it already holds. */
const settle = async (check: () => boolean) => {
  if (!check()) await nextNavigation();
  expect(check()).toBe(true);
};

beforeEach(() => {
  // The file shares one jsdom session history. A test that stepped Back leaves forward entries,
  // which history.length counts and the next push discards. Pushing, like a fresh page load,
  // drops them so each test starts on the last entry.
  history.pushState(null, '', '/BrainrotTCG/');
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('useRoute', () => {
  it('treats bare #/profile as your own profile page, not a shared profile or a broken link', () => {
    mount('/BrainrotTCG/#/profile');
    expect(current).toMatchObject({ route: 'profile', profile: null, broken: false });
  });

  it('still opens #/profile/<id> as a shared profile over Open', () => {
    mount(`/BrainrotTCG/#/profile/${PROFILE_ID}`);
    expect(current).toMatchObject({ route: 'open', profile: PROFILE_ID, broken: false });
  });

  it('adds an entry per page, and closing steps back to the Open entry it opened over', async () => {
    mount('/BrainrotTCG/');
    const start = history.length;
    act(() => current.navigate('cards'));
    expect(location.hash).toBe('#/cards');
    act(() => current.navigate('rankings'));
    expect(current.route).toBe('rankings');
    expect(history.length).toBe(start + 2);

    act(() => history.back());
    await settle(() => current.route === 'cards');

    act(() => current.closePage());
    await settle(() => current.route === 'open');
    expect(location.hash).toBe('');
    expect(history.length).toBe(start + 2);
  });

  it('swaps a page loaded directly for Open in place', () => {
    mount('/BrainrotTCG/#/settings');
    const start = history.length;
    act(() => current.closePage());
    expect(current.route).toBe('open');
    expect(location.href).toMatch(/\/BrainrotTCG\/$/);
    expect(history.length).toBe(start);
  });

  it('keeps the page behind a shared link, and closing the link returns to it', async () => {
    mount('/BrainrotTCG/');
    act(() => current.navigate('rankings'));
    act(() => { location.hash = `#/profile/${PROFILE_ID}`; });
    await settle(() => current.profile === PROFILE_ID);
    expect(current.route).toBe('rankings');

    act(() => current.closeLink());
    await settle(() => current.profile === null);
    expect(location.hash).toBe('#/rankings');
  });

  it('closes a link opened over a pack back onto the pack entry, so the next Back leaves the pack', async () => {
    mount('/BrainrotTCG/');
    history.pushState({ brainrotPack: true }, '');
    window.dispatchEvent(new Event(HISTORY_ENTRY_EVENT));
    act(() => { location.hash = '#/pull/abc'; });
    await settle(() => current.broken);

    act(() => current.closeLink());
    await settle(() => !current.broken);
    expect(history.state).toEqual({ brainrotPack: true });
    expect(location.hash).toBe('');
  });

  it('opens a page over a pack and returns to the pack entry from the Open tab', async () => {
    mount('/BrainrotTCG/');
    history.pushState({ brainrotPack: true }, '');
    window.dispatchEvent(new Event(HISTORY_ENTRY_EVENT));
    act(() => current.navigate('cards'));
    expect(history.state).toMatchObject({ brainrotDepth: 1, brainrotOverPack: true });

    act(() => current.navigate('open'));
    await settle(() => current.route === 'open');
    expect(history.state).toEqual({ brainrotPack: true });
  });

  it('pushes Open from a page that was opened over Open, so Back returns to the page', async () => {
    mount('/BrainrotTCG/');
    act(() => current.navigate('cards'));
    act(() => current.navigate('open'));
    expect(current.route).toBe('open');
    act(() => history.back());
    await settle(() => current.route === 'cards');
  });
});
