// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETS } from '../../content/sets';
import { admitOptional, resetAdmission } from '../../game/admission';
import { DEFAULT_SETTINGS } from '../../utils/settings';
import PackOpener from './PackOpener';

// The swipe is driven by hand: `cutter.cutting` says whether the player is mid-swipe, `cutter.tear` finishes one.
const cutter = vi.hoisted(() => ({ cutting: false, tear: () => {} }));
vi.mock('../../hooks/usePackCutter', () => ({
  usePackCutter: ({ onCutComplete }: { onCutComplete: () => void }) => {
    cutter.tear = onCutComplete;
    return {
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
    };
  },
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

describe('focus mode', () => {
  it('turns on with the tear, stays on through renders, and turns off when the opener unmounts mid-pack', async () => {
    const onFocusChange = vi.fn();
    const show = () => act(() => root.render(
      <PackOpener onOpen={() => {}} onShare={() => {}} onFocusChange={onFocusChange} set={SETS[0]} settings={DEFAULT_SETTINGS} />,
    ));
    await show();
    expect(onFocusChange).toHaveBeenLastCalledWith(false);
    await act(async () => cutter.tear());
    expect(onFocusChange).toHaveBeenLastCalledWith(true);

    onFocusChange.mockClear();
    await show();
    expect(onFocusChange).not.toHaveBeenCalled();

    act(() => root.unmount());
    expect(onFocusChange.mock.calls).toEqual([[false]]);
  });
});
