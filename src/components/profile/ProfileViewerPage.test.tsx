// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfileViewerPage from './ProfileViewerPage';
import type { CheckedProfile } from '../../engine';
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
    expect(status().textContent).toContain("Couldn't finish re-opening the packs on this device");
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

  it('offers no retry for a profile whose claims are false', () => {
    act(() => root.render(<ProfileViewerPage proof="proof" onClose={() => {}} />));
    act(() => reports[0]({ checked, packs: [], highlights: null, done: false, error: { rule: 'claims', message: 'Level is wrong' } }));
    expect(status().textContent).toContain('Not a real profile: Level is wrong');
    expect(retry()).toBeUndefined();
  });
});
