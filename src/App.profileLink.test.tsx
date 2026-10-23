// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSet } from './content/sets';
import { scorePulled, type CheckedProfile, type ProfilePack } from './engine';
import { toPulled } from './game/cardCode';
import type { ProfileProgress } from './game/profiles';
import App from './App';

const { verifyProfileLive } = vi.hoisted(() => ({ verifyProfileLive: vi.fn() }));
vi.mock('./game/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./game/profiles')>()),
  verifyProfileLive,
}));

// Two shared profiles whose best pulls come from different sets, so a leftover pack can't pass for the new one.
const LINK_A = 'a'.repeat(120);
const LINK_B = 'b'.repeat(120);
const setA = getSet('right-now', 1)!;
const setB = getSet('genesis', 1)!;
const bestIn = (set: typeof setA, nonce: number): ProfilePack => {
  const cards = toPulled(Array.from({ length: set.packSize }, () => ({ id: set.cards[0].id, holo: false })), set)!;
  return { nonce, set, cards, score: scorePulled(cards) };
};
const packA = bestIn(setA, 3);
const packB = bestIn(setB, 9);
const checkedFor = (name: string) =>
  ({
    profile: { publicKey: new Uint8Array(32), name, runs: [], xp: 0, highlights: [], signature: new Uint8Array(64) },
    tickets: [{}, {}],
    fingerprint: 'abcd1234',
  }) as unknown as CheckedProfile;
const checkedA = checkedFor('Alpha');
const checkedB = checkedFor('Bravo');

let container: HTMLDivElement;
let root: Root;
/** Each link's progress when its check starts: A has its best pull in; B is cached (done) or not started. */
let starts: Record<string, ProfileProgress>;

const viewer = () => document.querySelector<HTMLElement>('.profile-viewer')!;
const nested = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((d) => !d.classList.contains('profile-viewer'));
const openBest = () => act(() => document.querySelector<HTMLButtonElement>('.profile-block .pull-row')!.click());
const goTo = (link: string) =>
  act(async () => {
    window.location.hash = `#/profile/${link}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  localStorage.clear();
  starts = { [LINK_A]: { checked: checkedA, packs: [packA], highlights: [packA], done: false } };
  verifyProfileLive.mockReset().mockImplementation((text: string, onProgress: (p: ProfileProgress) => void) => {
    onProgress(starts[text]);
    return starts[text].checked;
  });
  // The viewer's chunk is already loaded, so opening a link needs no wait beyond the microtask the loader takes.
  await import('./components/profile/ProfileViewerPage');
  window.location.hash = `#/profile/${LINK_A}`;
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.location.hash = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('moving between shared profile links in the app', () => {
  it('opens profile A with its own best pull', () => {
    expect(viewer().textContent).toContain('Alpha');
    openBest();
    expect(nested()).toHaveLength(1);
    expect(nested()[0].textContent).toContain(`${setA.name} · ticket #3`);
  });

  it('closes A’s open pack when the address changes to B, which is still being checked', async () => {
    starts[LINK_B] = { checked: checkedB, packs: [], highlights: null, done: false };
    openBest();
    await goTo(LINK_B);
    expect(verifyProfileLive.mock.calls.map((call) => call[0])).toEqual([LINK_A, LINK_B]);
    expect(viewer().textContent).toContain('Bravo');
    expect(nested()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('ticket #3');
  });

  it('closes it when B is already cached, and B’s own best pull then opens B’s set', async () => {
    starts[LINK_B] = { checked: checkedB, packs: [packB], highlights: [packB], done: true };
    openBest();
    await goTo(LINK_B);
    expect(viewer().textContent).toContain('Bravo');
    expect(nested()).toHaveLength(0);

    openBest();
    expect(nested()).toHaveLength(1);
    expect(nested()[0].textContent).toContain(`${setB.name} · ticket #9`);
    expect(nested()[0].textContent).not.toContain(setA.name);
  });
});
