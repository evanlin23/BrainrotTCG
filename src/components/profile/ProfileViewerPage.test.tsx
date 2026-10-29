// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfileViewerPage from './ProfileViewerPage';
import { scorePulled, type CheckedProfile, type ProfilePack } from '../../engine';
import { SETS, getSet } from '../../content/sets';
import { toPulled } from '../../game/cardCode';
import type { ProfileProgress } from '../../game/profileVerification';

const { verifyProfileLive } = vi.hoisted(() => ({ verifyProfileLive: vi.fn() }));
vi.mock('../../game/profileVerification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/profileVerification')>()),
  verifyProfileLive,
}));

const OUT_OF_MEMORY = 'This device ran out of memory while checking. Close other tabs and try again.';

const checked = {
  profile: { publicKey: new Uint8Array(32), name: 'Tester', runs: [], xp: 0, highlights: [], signature: new Uint8Array(64) },
  tickets: [{}, {}],
  fingerprint: 'abcd1234',
} as unknown as CheckedProfile;

const pack = (nonce: number): ProfilePack => ({ nonce, set: SETS[0], cards: [], score: scorePulled([]) });

let root: Root;
let container: HTMLElement;
let reports: ((p: ProfileProgress) => void)[];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  reports = [];
  verifyProfileLive.mockReset().mockImplementation((_text: string, onProgress: (p: ProfileProgress) => void) => {
    reports.push(onProgress);
    onProgress({ checked, packs: [], highlights: null, done: false });
    return checked;
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const status = () => document.querySelector<HTMLElement>('.profile-verify')!;
const retry = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.includes('Try again'));

describe('ProfileViewerPage', () => {
  it('explains a failed check in plain words and re-runs it on Try again', () => {
    act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
    expect(verifyProfileLive).toHaveBeenCalledTimes(1);
    expect(retry()).toBeUndefined();

    act(() => reports[0]({ checked, packs: [], highlights: null, done: false, error: { message: OUT_OF_MEMORY } }));
    expect(status().textContent).toContain('Check interrupted');
    expect(status().textContent).toContain(OUT_OF_MEMORY);
    expect(retry()).toBeDefined();

    act(() => retry()!.click());
    expect(verifyProfileLive).toHaveBeenCalledTimes(2);
    expect(verifyProfileLive.mock.calls[1][0]).toBe('proof');
    // The first run was stopped, and the new one starts from a clean status.
    expect((verifyProfileLive.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    expect(status().textContent).not.toContain(OUT_OF_MEMORY);
    expect(retry()).toBeUndefined();
  });

  it('names an unnamed or blocked player Someone, beside the fingerprint', () => {
    for (const name of ['', '  ', 'xXfuckXx']) {
      const profile = { ...checked.profile, name };
      verifyProfileLive.mockImplementationOnce((_text: string, onProgress: (p: ProfileProgress) => void) => {
        onProgress({ checked: { ...checked, profile } as CheckedProfile, packs: [], highlights: null, done: false });
        return checked;
      });
      act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
      const sheet = document.querySelector('.profile-viewer')!;
      expect(sheet.textContent).toContain('Someone');
      expect(sheet.textContent).toContain('#abcd1234');
      expect(document.body.textContent).not.toMatch(/Anonymous|Player/);
      act(() => root.render(null));
    }
  });

  it('while checking, never says the packs were re-opened and keeps the level as claimed', () => {
    act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
    expect(status().textContent).toContain('Checking');
    expect(status().textContent).toContain('0/2');
    expect(status().textContent).toContain('Checking: packs re-opened in your browser');
    expect(status().textContent).not.toContain('this device');
    expect(status().textContent).toContain('Not verified yet');
    expect(status().textContent).not.toContain('Verified');
    expect(document.body.textContent).toContain('claimed');
    expect(document.body.textContent).not.toContain('actually hold');
    expect(document.body.textContent).toContain('nothing here counts as verified');
    // The pack total lives in the stats and progress, not the subtitle.
    expect(document.querySelector('.share-fp')!.parentElement!.textContent).not.toMatch(/\bpacks?\b/);

    act(() => reports[0]({ checked, packs: [pack(0)], highlights: [pack(0)], done: false }));
    expect(status().textContent).toContain('1/2');
    // One text run in the flex line (icon + label), so it wraps as a sentence, not in columns.
    expect(status().querySelector('.profile-verify-line')!.childNodes).toHaveLength(2);
    expect(status().textContent).toContain('Best pulls re-opened');
    expect(status().textContent).not.toContain('Verified');
    expect(document.body.textContent).not.toContain('actually hold');
  });

  it('after an interruption, marks the totals as partial, drops the claimed level, and resumes on Try again', () => {
    act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
    act(() => reports[0]({ checked, packs: [pack(0)], highlights: null, done: false, error: { message: OUT_OF_MEMORY } }));
    const text = document.body.textContent!;
    expect(status().textContent).toContain('only 1/2 packs re-opened');
    // One text run in the flex line (icon + label), so it wraps as a sentence, not in columns.
    const line = status().querySelector('.profile-verify-line')!;
    expect(line.children).toHaveLength(2);
    expect(line.children[1].textContent).toBe('Check interrupted: only 1/2 packs re-opened in your browser');
    expect(text).toContain('the rest are unchecked');
    expect(text).toContain('from re-opened packs only');
    expect(text).not.toContain('claimed');
    expect(text).toContain('* from the 1 of 2 packs re-opened before the check stopped');
    expect(text).toContain('cards*');
    expect(text).not.toContain('actually hold');
    expect(text).toContain('the profile is not verified');
    expect(retry()).toBeDefined();

    act(() => retry()!.click());
    expect(status().textContent).toContain('Checking');
    expect(status().textContent).not.toContain('interrupted');
    expect(document.body.textContent).toContain('claimed');
  });

  it('does not say "only N/N" when an error arrives after every pack is in', () => {
    act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
    act(() => reports[0]({ checked, packs: [pack(0), pack(1)], highlights: null, done: false, error: { message: OUT_OF_MEMORY } }));
    expect(status().textContent).toContain('Check interrupted before it finished');
    expect(status().textContent).not.toContain('only');
    expect(document.body.textContent).not.toContain('the rest are unchecked');
    expect(document.body.textContent).not.toContain('1 of 2 packs');
    // The footnote must not claim packs are still being re-opened once the check has stopped.
    const text = document.body.textContent!;
    expect(text).not.toContain('so far');
    expect(text).not.toContain('while the rest of the packs are re-opened');
    expect(text).toContain('* from the packs re-opened before the check stopped');
    expect(text).toContain('packs*');
  });

  it('claims completed verification, with complete totals, only when every pack is in', () => {
    act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
    act(() => reports[0]({ checked, packs: [pack(0), pack(1)], highlights: [pack(0)], done: true }));
    expect(status().textContent).toContain('This profile checks out: every pack re-opened in your browser');
    expect(status().textContent).not.toContain('this device');
    expect(status().textContent).not.toMatch(/\d/);
    const text = document.body.textContent!;
    expect(text).toContain('actually hold');
    expect(text).not.toContain('claimed');
    expect(text).not.toContain('cards*');
    expect(text).not.toContain('so far');
    expect(retry()).toBeUndefined();
  });

  it('gives a failed claim no success explanation', () => {
    act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
    act(() => reports[0]({ checked, packs: [pack(0), pack(1)], highlights: null, done: false, error: { rule: 'claims', message: 'Level is wrong' } }));
    expect(status().textContent).not.toContain('Verified');
    expect(document.body.textContent).not.toContain('actually hold');
    expect(document.body.textContent).toContain("isn't a real profile and nothing about it counts as verified");
  });

  it('offers no retry for a profile whose claims are false', () => {
    act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
    act(() => reports[0]({ checked, packs: [], highlights: null, done: false, error: { rule: 'claims', message: 'Level is wrong' } }));
    expect(status().textContent).toContain('Not a real profile: Level is wrong');
    expect(retry()).toBeUndefined();
  });

  it('supports two-stage verification: marks highlights verified fast, offers full verification on demand', () => {
    const cardPack = { ...pack(0), cards: toPulled([{ id: SETS[0].cards[0].id, holo: false }], SETS[0])! };
    act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
    // Called initially with highlightsOnly: true
    expect(verifyProfileLive).toHaveBeenCalledTimes(1);
    expect(verifyProfileLive.mock.calls[0][3]).toEqual({ highlightsOnly: true });

    // Stage 1 completes: highlights are in
    act(() => reports[0]({ checked, packs: [cardPack], highlights: [cardPack], highlightsDone: true, done: false }));
    expect(status().textContent).toContain('Best pulls re-opened in your browser');
    expect(status().textContent).not.toContain('Checking: packs re-opened');
    // Best pull row has Verified badge
    const bestPullBadge = document.querySelector('.pulls-list .profile-verified');
    expect(bestPullBadge).not.toBeNull();
    expect(bestPullBadge?.textContent).toContain('Verified');

    // Prompt/button to verify full profile is shown
    const fullBtn = document.querySelector<HTMLButtonElement>('.profile-verify-full')!;
    expect(fullBtn).not.toBeNull();
    expect(fullBtn.textContent).toBe('Verify all 2 packs');

    // Click to start Stage 2: focus lands on the status line, not on the page behind the dialog
    act(() => fullBtn.click());
    expect(document.activeElement).toBe(status());
    expect(verifyProfileLive).toHaveBeenCalledTimes(2);
    expect(verifyProfileLive.mock.calls[1][3]).toEqual({ highlightsOnly: false });

    // Stage 2 completes: all packs verified
    act(() => reports[1]({ checked, packs: [cardPack, pack(1)], highlights: [cardPack], highlightsDone: true, done: true }));
    expect(status().textContent).toContain('This profile checks out: every pack re-opened in your browser');
    expect(document.querySelector('.profile-verify-full')).toBeNull();
  });

  describe('once the best packs are re-opened and the check has paused', () => {
    const best = () => ({ ...pack(0), cards: toPulled([{ id: SETS[0].cards[0].id, holo: false }], SETS[0])! });
    const pause = () => {
      const cardPack = best();
      act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
      act(() => reports[0]({ checked, packs: [cardPack], highlights: [cardPack], highlightsDone: true, done: false }));
      return cardPack;
    };
    const how = () => [...document.querySelectorAll<HTMLElement>('.profile-how')].find((d) => d.querySelector('summary')?.textContent === 'How do we know?')!.textContent ?? '';
    const footnote = () => document.querySelector('.profile-footnote')?.textContent ?? '';

    it('does not say work is running: no progress bar, no "so far", no "re-opening now"', () => {
      pause();
      expect(document.querySelector('.profile-verify .progress')).toBeNull();
      expect(document.querySelector('.profile-verify .spin')).toBeNull();
      expect(status().textContent).toContain('Only the best packs are re-opened. The rest are not checked');
      expect(footnote()).toBe("* the pack count is the link's own; cards, holo and best score are from the 1 best pack only, and the rest of the packs are not checked");
      expect(footnote()).not.toContain('so far');
      expect(how()).toContain('re-opened the 1 best pack itself');
      expect(how()).toContain('they come out in the order the link lists');
      expect(how()).not.toContain('match the link');
      expect(how()).toContain('The rest of the packs are not checked until you ask');
      expect(how()).not.toContain('re-opening those packs now');
      expect(how()).not.toContain('so far');
      // The check itself is not claimed: the badge is per pack, the profile is not verified.
      expect(status().textContent).not.toContain('checks out');
      expect(how()).toContain('the profile as a whole is not verified');
    });

    it('keeps the best packs\' Verified badge while the full check runs, with a progress bar again', () => {
      const cardPack = pause();
      act(() => document.querySelector<HTMLButtonElement>('.profile-verify-full')!.click());
      // A fresh run has nothing yet, then the best packs come back from the cache.
      expect(document.querySelector('.pulls-list .profile-verified')).toBeNull();
      act(() => reports[1]({ checked, packs: [cardPack], highlights: [cardPack], done: false }));
      expect(document.querySelector('.pulls-list .profile-verified')).not.toBeNull();
      expect(document.querySelector('.profile-verify .progress')).not.toBeNull();
      expect(footnote()).toBe('* so far, while the rest of the packs are re-opened');
      expect(status().textContent).not.toContain('checks out');
    });

    it('keeps the mode on Try again: a highlights-only error retries highlights only, a full one retries the full check', () => {
      act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
      act(() => reports[0]({ checked, packs: [], highlights: null, done: false, error: { message: OUT_OF_MEMORY } }));
      act(() => retry()!.click());
      expect(verifyProfileLive.mock.calls[1][3]).toEqual({ highlightsOnly: true });

      const cardPack = best();
      act(() => reports[1]({ checked, packs: [cardPack], highlights: [cardPack], highlightsDone: true, done: false }));
      act(() => document.querySelector<HTMLButtonElement>('.profile-verify-full')!.click());
      expect(verifyProfileLive.mock.calls[2][3]).toEqual({ highlightsOnly: false });
      act(() => reports[2]({ checked, packs: [cardPack], highlights: [cardPack], done: false, error: { message: OUT_OF_MEMORY } }));
      act(() => retry()!.click());
      expect(verifyProfileLive).toHaveBeenCalledTimes(4);
      expect(verifyProfileLive.mock.calls[3][3]).toEqual({ highlightsOnly: false });
    });
  });

  describe('moving from one shared profile to another', () => {
    // Two profiles whose best pulls come from different sets, so a leftover pack can't pass for the new one.
    const setA = getSet('right-now', 1)!;
    const setB = getSet('genesis', 1)!;
    const bestIn = (set: typeof setA, nonce: number, cardIndex: number): ProfilePack => {
      const cards = toPulled(Array.from({ length: set.packSize }, () => ({ id: set.cards[cardIndex].id, holo: false })), set)!;
      return { nonce, set, cards, score: scorePulled(cards) };
    };
    const packA = bestIn(setA, 3, 0);
    const packB = bestIn(setB, 9, 1);
    const checkedB = { ...checked, fingerprint: 'beefbeef', profile: { ...checked.profile, name: 'Other' } } as unknown as CheckedProfile;

    const render = (proof: string) => act(() => root.render(<ProfileViewerPage proof={proof} onClose={() => {}} />));
    const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
    const nested = () => dialogs().filter((d) => !d.classList.contains('profile-viewer'));
    const bestRows = () => [...document.querySelectorAll<HTMLButtonElement>('.profile-block .pull-row')];
    const openBest = () => act(() => bestRows()[0].click());
    /** What each link's check reports the moment it starts; a cached profile is complete at once. */
    const starts: Record<string, ProfileProgress> = {};
    const aborted = (call: number) => (verifyProfileLive.mock.calls[call][2] as AbortSignal).aborted;

    beforeEach(() => {
      starts.A = { checked, packs: [packA], highlights: [packA], done: false };
      verifyProfileLive.mockImplementation((text: string, onProgress: (p: ProfileProgress) => void) => {
        reports.push(onProgress);
        onProgress(starts[text]);
        return checked;
      });
    });

    it('closes profile A’s open pack while profile B is still being checked', () => {
      starts.B = { checked: checkedB, packs: [], highlights: null, done: false };
      render('A');
      openBest();
      expect(nested()).toHaveLength(1);
      expect(nested()[0].textContent).toContain(`${setA.name} · ticket #3`);

      render('B');
      expect(nested()).toHaveLength(0);
      expect(dialogs()).toHaveLength(1);
      expect(document.body.textContent).toContain('Other');
      expect(document.body.textContent).not.toContain(`ticket #3`);
      // A's check was stopped, and a late report from it changes nothing.
      expect(aborted(0)).toBe(true);
      expect(aborted(1)).toBe(false);
      act(() => reports[0]({ checked, packs: [packA], highlights: [packA], done: true }));
      expect(document.body.textContent).toContain('Other');
      expect(bestRows()).toHaveLength(0);
    });

    it('closes it when B is already cached, and B’s own best pull opens its own set and cards', () => {
      starts.B = { checked: checkedB, packs: [packB], highlights: [packB], done: true };
      render('A');
      openBest();
      render('B');
      expect(nested()).toHaveLength(0);
      expect(status().textContent).toContain('This profile checks out');
      expect(bestRows()).toHaveLength(1);

      openBest();
      expect(nested()).toHaveLength(1);
      expect(nested()[0].textContent).toContain(`${setB.name} · ticket #9`);
      expect(nested()[0].textContent).not.toContain(setA.name);
      expect(nested()[0].querySelectorAll('img').length).toBeGreaterThan(0);
      expect([...nested()[0].querySelectorAll('img')].every((img) => img.getAttribute('src')?.includes(setB.id))).toBe(true);
    });

    it('closes it when B fails, whether the link is bad or its claims are false', () => {
      starts.B = { checked: checkedB, packs: [], highlights: null, done: false, error: { rule: 'claims', message: 'Level is wrong' } };
      render('A');
      openBest();
      render('B');
      expect(nested()).toHaveLength(0);
      expect(status().textContent).toContain('Not a real profile: Level is wrong');

      render('A');
      openBest();
      expect(nested()).toHaveLength(1);
      verifyProfileLive.mockImplementationOnce(() => {
        throw new Error('That link is cut off');
      });
      render('C');
      // The one sheet left is the not-valid notice, with no pack from A over it.
      expect(dialogs()).toHaveLength(1);
      expect(document.body.textContent).toContain('That link is cut off');
      expect(document.body.textContent).not.toContain('ticket #3');
    });

    it('keeps the pack open as the same profile streams more progress', () => {
      render('A');
      openBest();
      act(() => reports[0]({ checked, packs: [packA, pack(1)], highlights: [packA], done: false }));
      expect(status().textContent).toContain('2/2');
      expect(nested()).toHaveLength(1);
      act(() => reports[0]({ checked, packs: [packA, pack(1)], highlights: [packA], done: true }));
      expect(nested()).toHaveLength(1);
      expect(verifyProfileLive).toHaveBeenCalledTimes(1);
    });

    it('still closes the pack on Escape, then the profile on the next', () => {
      const onClose = vi.fn();
      act(() => root.render(<ProfileViewerPage proof="A" onClose={onClose} />));
      openBest();
      act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      expect(nested()).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();
      act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
