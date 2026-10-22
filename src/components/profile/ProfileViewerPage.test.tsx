// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfileViewerPage from './ProfileViewerPage';
import { scorePulled, type CheckedProfile, type ProfilePack } from '../../engine';
import { SETS } from '../../content/sets';
import type { ProfileProgress } from '../../game/profiles';

const { verifyProfileLive } = vi.hoisted(() => ({ verifyProfileLive: vi.fn() }));
vi.mock('../../game/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/profiles')>()),
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

  it('while checking, never says the packs were re-opened and keeps the level as claimed', () => {
    act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
    expect(status().textContent).toContain('Checking');
    expect(status().textContent).toContain('0/2');
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
    expect(line.children[1].textContent).toBe('Check interrupted: only 1/2 packs re-opened on this device');
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
    expect(status().textContent).toContain('Verified on this device: every pack re-opened');
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
});
