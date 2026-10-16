// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MyProfilePage from './MyProfilePage';

const { myProfileInfo, myProfileProof, myStats, myPackCacheState, hydrateMyPacks } = vi.hoisted(() => ({
  myProfileInfo: vi.fn(), myProfileProof: vi.fn(), myStats: vi.fn(), myPackCacheState: vi.fn(), hydrateMyPacks: vi.fn(),
}));
vi.mock('../../game/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/profiles')>()),
  myProfileInfo,
  myProfileProof,
  myStats,
  myPackCacheState,
  hydrateMyPacks,
}));
const actual = await vi.importActual<typeof import('../../game/profiles')>('../../game/profiles');
const { getHistory } = vi.hoisted(() => ({ getHistory: vi.fn() }));
vi.mock('../../game/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/history')>()),
  getHistory,
}));
const actualHistory = await vi.importActual<typeof import('../../game/history')>('../../game/history');

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver; the page's Sheet only uses it to track overflow.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  myProfileInfo.mockReset().mockReturnValue({ packs: 3, filled: 0, missing: 0, cache: 'ready' });
  myProfileProof.mockReset();
  myStats.mockReset().mockImplementation(actual.myStats);
  myPackCacheState.mockReset().mockReturnValue('ready');
  hydrateMyPacks.mockReset().mockResolvedValue('ready');
  getHistory.mockReset().mockImplementation(actualHistory.getHistory);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () =>
  act(() =>
    root.render(
      <MyProfilePage stats={{}} onClose={() => {}} onSharePull={() => {}} />,
    ),
  );
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.includes(label))!;
const alert = () => document.querySelector<HTMLElement>('[role="alert"]');

describe('profile link failures', () => {
  it.each(['Copy profile link', 'Player card'])('shows why %s failed when another tab changed the save, and can retry', async (label) => {
    myProfileProof.mockRejectedValueOnce(new Error('Your save changed while the profile link was being prepared. Try again.'));
    render();
    await act(async () => button(label).click());
    expect(alert()?.textContent).toContain('Your save changed while the profile link was being prepared.');
    expect(alert()?.textContent).toContain('try again once it finishes');
    expect(button(label).disabled).toBe(false);

    // The next attempt clears the old error.
    myProfileProof.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => button(label).click());
    expect(alert()).toBeNull();
    expect(myProfileProof).toHaveBeenCalledTimes(2);
  });

  it('recounts what a link can prove when another tab records a pack', () => {
    render();
    expect(myProfileInfo).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-settings-v1' })));
    expect(myProfileInfo).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-history-v1' })));
    expect(myProfileInfo).toHaveBeenCalledTimes(2);
  });

  it('refuses only the link and player card when a ticket has no original mapping', () => {
    myProfileInfo.mockReturnValue({ packs: 3, filled: 1, missing: 2, cache: 'ready' });
    render();
    expect(button('Copy profile link').disabled).toBe(true);
    expect(button('Player card').disabled).toBe(true);
    expect(document.body.textContent).toContain('A complete profile link or player card cannot be created from this save.');
    expect(document.body.textContent).toContain('Keep a private export (open Player, then Save & restore)');
    expect(document.body.textContent).not.toMatch(/from Settings/);
    expect(button('Re-open them').disabled).toBe(false);
  });
});

describe('saved packs still being read', () => {
  it('shows loading, then a failed read with a retry, but never zero or a re-open prompt', () => {
    myProfileInfo.mockReturnValue({ packs: 3, filled: 0, missing: 3, cache: 'loading' });
    myStats.mockReturnValue(null);
    myPackCacheState.mockReturnValue('loading');
    render();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Reading your saved packs');
    expect(document.querySelector('.profile-summary')).toBeNull();
    expect(document.body.textContent).not.toContain("don't have their cards on this device");

    myProfileInfo.mockReturnValue({ packs: 3, filled: 0, missing: 3, cache: 'failed' });
    myPackCacheState.mockReturnValue('failed');
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect(alert()?.textContent).toContain("Couldn't read your saved packs on this device just now");
    expect(document.querySelector('.profile-summary')).toBeNull();
    act(() => button('Try again').click());
    expect(hydrateMyPacks).toHaveBeenCalledTimes(1);
    expect(button('Re-open the packs instead').disabled).toBe(false);
  });
});

describe('pack list order and Rankings wording', () => {
  const entry = (hand: string, score: number, openedAt: number) => ({
    setId: 'genesis', setVersion: 1, nonce: openedAt, key: 'abcdef0123456789', cards: null, hand, score, openedAt,
  });
  const hands = () => [...document.querySelectorAll('.pull-row-hand')].map((el) => el.firstChild?.textContent);
  const tab = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) => el.textContent?.startsWith(label))!;

  it('lists the best packs first, then newest on request, and names the Rankings filter plainly', () => {
    // Stored newest first: the oldest pack is the best one.
    getHistory.mockReturnValue([entry('Pair', 100, 3000), entry('Two Pair', 300, 2000), entry('Full House', 900, 1000)]);
    render();
    expect([...document.querySelectorAll('[role="tab"]')].map((el) => el.textContent)).toEqual(['Best', 'Newest', 'For Rankings · 1']);
    expect(tab('Best').getAttribute('aria-selected')).toBe('true');
    expect(hands()).toEqual(['Full House', 'Two Pair', 'Pair']);
    expect(document.querySelector('.pull-row-hand .sr-only')?.textContent).toBe(', qualifies for Rankings');

    act(() => tab('Newest').click());
    expect(hands()).toEqual(['Pair', 'Two Pair', 'Full House']);

    act(() => tab('For Rankings').click());
    expect(hands()).toEqual(['Full House']);
    expect(document.querySelector('.pulls-note')?.textContent).toBe('These qualify for Rankings, the public Hall of Fame. Open one to share it or submit it.');
  });

  it('says what qualifies for Rankings when nothing does yet', () => {
    getHistory.mockReturnValue([entry('Pair', 100, 3000)]);
    render();
    act(() => tab('For Rankings').click());
    expect(document.querySelector('.pulls-note')?.textContent).toMatch(/^None yet: a Full House or better, or a Brainrot Score of [\d,]+\+, qualifies for Rankings\.$/);
  });
});
