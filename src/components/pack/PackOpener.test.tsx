// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETS } from '../../content/sets';
import { admitOptional, resetAdmission } from '../../game/admission';
import { DEFAULT_SETTINGS } from '../../utils/settings';
import PackOpener from './PackOpener';

// The swipe is driven by hand: `cutter.cutting` says whether the player is mid-swipe.
const cutter = vi.hoisted(() => ({ cutting: false }));
vi.mock('../../hooks/usePackCutter', () => ({
  usePackCutter: () => ({
    packRef: { current: null },
    isCutting: cutter.cutting,
    cutPoints: [],
    sparks: [],
    resetCutState: () => {},
    completeCut: () => {},
    handlePointerDown: () => {},
    handlePointerMove: () => {},
    handlePointerEnd: () => {},
    endCutAttempt: () => {},
    cleanup: () => {},
  }),
}));
vi.mock('../../game/pulls', () => ({ openPack: vi.fn(() => new Promise(() => {})), prefetchNextPack: vi.fn() }));
vi.mock('../../utils/confettiEffects', () => ({ triggerRarityConfetti: vi.fn(), triggerHoloSparkles: vi.fn() }));

let root: Root;

const render = (disabled: boolean) =>
  act(() => root.render(<PackOpener onOpen={() => {}} onShare={() => {}} set={SETS[0]} settings={DEFAULT_SETTINGS} disabled={disabled} />));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no matchMedia; the pack asks it whether the pointer is a finger.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  resetAdmission();
  cutter.cutting = false;
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('optional work around a pack', () => {
  it('waits while the pack is swiped, but not while a sheet covers it', async () => {
    const work = vi.fn(async () => {});
    cutter.cutting = true;
    await render(false);
    const done = admitOptional(work);
    await act(async () => {});
    expect(work).not.toHaveBeenCalled();

    // A sheet opened over the pack (a shared pull or profile link): its check starts at once.
    await render(true);
    await act(async () => {});
    expect(work).toHaveBeenCalledOnce();
    await done;
  });

  it('runs at once while a pack just sits on screen', async () => {
    const work = vi.fn(async () => {});
    await render(false);
    await admitOptional(work);
    expect(work).toHaveBeenCalledOnce();
  });
});
