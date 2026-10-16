// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_FLIP_SRC, EFFECT_DELAY_MS } from '../../constants/audio';
import { SETS } from '../../content/sets';
import { admitOptional, resetAdmission } from '../../game/admission';
import { openPack } from '../../game/pulls';
import { DEFAULT_SETTINGS } from '../../utils/settings';
import PackOpener from './PackOpener';
import { REFUSAL_COPY } from './refusal';

// The swipe is driven by hand: `cutter.cutting` says whether the player is mid-swipe, `cutter.tear` finishes one,
// and completeCut finishes one the way the real cutter does (the Open pack button calls it).
// Its callbacks are stable, as the real hook's are: the opener's unmount cleanup depends on them.
const cutter = vi.hoisted(() => ({
  cutting: false, tear: () => {}, endCutAttempt: vi.fn(), completeCut: vi.fn(), resetCutState: () => {}, cleanup: () => {},
}));
vi.mock('../../hooks/usePackCutter', () => ({
  usePackCutter: ({ onCutComplete }: { onCutComplete: () => void }) => {
    cutter.tear = onCutComplete;
    return {
      packRef: { current: null },
      isCutting: cutter.cutting,
      cutPoints: [],
      sparks: [],
      resetCutState: cutter.resetCutState,
      completeCut: cutter.completeCut,
      handlePointerDown: () => {},
      handlePointerMove: () => {},
      handlePointerEnd: () => {},
      endCutAttempt: cutter.endCutAttempt,
      cleanup: cutter.cleanup,
    };
  },
}));
vi.mock('../../game/pulls', () => ({ openPack: vi.fn(() => new Promise(() => {})), prefetchNextPack: vi.fn() }));
vi.mock('../../utils/confettiEffects', () => ({ triggerRarityConfetti: vi.fn(), triggerHoloSparkles: vi.fn() }));
vi.mock('../../game/reload', () => ({ reloadPage: vi.fn() }));

let root: Root;

const render = (disabled: boolean, openBlocked = false, settings = DEFAULT_SETTINGS) =>
  act(() => root.render(
    <PackOpener onOpen={() => {}} onShare={() => {}} set={SETS[0]} settings={settings} disabled={disabled} openBlocked={openBlocked} />,
  ));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no matchMedia; the pack asks it whether the pointer is a finger.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  resetAdmission();
  cutter.cutting = false;
  cutter.endCutAttempt.mockReset();
  cutter.completeCut.mockReset().mockImplementation(() => cutter.tear());
  vi.mocked(openPack).mockReset().mockImplementation(() => new Promise(() => {}));
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

describe('a stroke cut short by leaving the page (#266)', () => {
  const setVisibility = (state: DocumentVisibilityState) =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });

  afterEach(() => {
    // Drop the own property so jsdom's own getter answers again.
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  });

  it('ends the stroke when the window loses focus or the page is hidden, not when it shows again', async () => {
    await render(false);
    window.dispatchEvent(new Event('blur'));
    expect(cutter.endCutAttempt).toHaveBeenCalledOnce();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cutter.endCutAttempt).toHaveBeenCalledTimes(2);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cutter.endCutAttempt).toHaveBeenCalledTimes(2);
  });

  it('stops listening once the opener unmounts', async () => {
    await render(false);
    act(() => root.unmount());
    setVisibility('hidden');
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cutter.endCutAttempt).not.toHaveBeenCalled();
  });
});

describe('the controls under the pack (#312)', () => {
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
  const openButton = () => $<HTMLButtonElement>('.pack-open-button');
  const retryButton = () => $<HTMLButtonElement>('.pack-retry-button');
  const announced = () => $('.pack-opener-container > [aria-live="polite"]')?.textContent;
  /** Past the tear's 460ms pause, to where the ticket is asked for, and let a refused one settle. */
  const pastTheTear = async () => {
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => {});
  };

  beforeEach(async () => {
    // A test that unmounts mid-pack steps browser history back; let that land before this one starts.
    // jsdom takes three chained timer turns (queue, traverse, fire popstate). A Back landing after this
    // test's tear reads as the player leaving, so the refused ticket would show no refusal.
    for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => vi.useRealTimers());

  it('opens the pack with one press, through the same cut and ticket as a swipe', async () => {
    await render(false);
    expect(openButton()?.textContent).toBe('Open pack');
    expect($('.pack-shell')?.getAttribute('role')).toBeNull();
    expect($('.pack-shell')?.hasAttribute('tabindex')).toBe(false);

    act(() => openButton()!.click());
    expect(cutter.completeCut).toHaveBeenCalledOnce();
    // Torn: a second press does nothing while the ticket is on its way.
    expect(openButton()?.getAttribute('aria-disabled')).toBe('true');
    act(() => openButton()!.click());
    expect(cutter.completeCut).toHaveBeenCalledOnce();

    await pastTheTear();
    expect(openPack).toHaveBeenCalledOnce();
    expect(openPack).toHaveBeenCalledWith(SETS[0]);
  });

  it('says why a refused ticket opened nothing, and Try again asks for it again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(openPack).mockRejectedValueOnce(new Error('ticket refused'));
    await render(false);
    openButton()!.focus();
    act(() => openButton()!.click());
    await pastTheTear();

    expect($('.pack-refusal-text')?.textContent).toBe(REFUSAL_COPY.failed.message);
    expect(announced()).toBe(REFUSAL_COPY.failed.message);
    expect(retryButton()?.textContent).toBe('Try again');
    expect(openButton()).toBeNull();
    // The button the player pressed went: focus moved to Try again, not the page.
    expect(document.activeElement).toBe(retryButton());

    act(() => retryButton()!.click());
    expect(cutter.completeCut).toHaveBeenCalledTimes(2);
    expect($('.pack-refusal-text')).toBeNull();
    expect(announced()).toBe('');
    // Try again went with the refusal: focus is on the Open pack button that came back, not the page.
    expect(retryButton()).toBeNull();
    expect(document.activeElement).toBe(openButton());
    await pastTheTear();
    expect(openPack).toHaveBeenCalledTimes(2);
  });

  it('keeps the pack sealed while another tab holds the save, and says so instead of tearing it', async () => {
    await render(false, true);
    act(() => openButton()!.click());
    expect(cutter.completeCut).not.toHaveBeenCalled();
    expect($('.pack-refusal-text')?.textContent).toBe(REFUSAL_COPY.blocked.message);
    expect(announced()).toBe(REFUSAL_COPY.blocked.message);
    expect(retryButton()?.textContent).toBe(REFUSAL_COPY.blocked.action);
    await pastTheTear();
    expect(openPack).not.toHaveBeenCalled();
  });

  it('announces the wait for a slow ticket in the one live region', async () => {
    await render(false);
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
    act(() => openButton()!.click());
    await pastTheTear();
    expect(announced()).toBe('');
    await act(async () => { vi.advanceTimersByTime(1300); });
    expect(announced()).toBe('Opening the pack…');
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });
});

describe('the reveal sounds on a first pack', () => {
  // Opens a pack and returns which sounds started downloading, before and after the page goes idle.
  const openAndIdle = async (settings = DEFAULT_SETTINGS) => {
    // A test that unmounts mid-pack steps browser history back; let that land before this one starts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const idle: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (task: () => void) => idle.push(task));
    vi.stubGlobal('cancelIdleCallback', () => {});
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    // Raising preload is what starts a deferred download, so track which sounds asked for one.
    const preload = vi.spyOn(HTMLMediaElement.prototype, 'preload', 'set');
    const downloading = () => new Set(preload.mock.calls.flatMap(([value], i) => (value === 'auto' ? [preload.mock.contexts[i]] : [])));
    const set = SETS[0];
    const cards = set.cards.slice(0, set.packSize ?? 5).map((card, i) => ({ ...card, uniqueId: i, isRevealed: false, isHolo: false }));
    vi.mocked(openPack).mockResolvedValue({
      setId: set.id, setVersion: set.version, nonce: 0, cards, openedAt: 0,
    } as unknown as Awaited<ReturnType<typeof openPack>>);
    try {
      await render(false, false, settings);
      act(() => document.querySelector<HTMLButtonElement>('.pack-open-button')!.click());
      await act(async () => { vi.advanceTimersByTime(500); });
      await act(async () => {});
      // Dealt (the reveal itself waits on the pack's exit animation, which jsdom doesn't run).
      expect(openPack).toHaveBeenCalledOnce();
      const before = downloading().size;
      const waiting = idle.length;
      act(() => idle.splice(0).forEach((task) => task()));
      return {
        before, waiting, after: downloading().size,
        starts: preload.mock.calls.filter(([value]) => value === 'auto').length,
        loads: load.mock.calls.length,
      };
    } finally {
      preload.mockRestore();
      load.mockRestore();
      vi.useRealTimers();
    }
  };

  it('download only once the reveal is drawn and the page is idle, not ahead of its card backs', async () => {
    const { before, waiting, after, starts, loads } = await openAndIdle();
    // Its sounds wait for the page to go idle rather than racing its card backs.
    expect(waiting).toBeGreaterThan(0);
    expect(before).toBe(0);
    expect(after).toBeGreaterThan(0);
    // Each starts once, in place: load() would abort the download and fetch it again.
    expect(starts).toBe(after);
    expect(loads).toBe(0);
  });

  it('download nothing while effects are muted, since none of them would play', async () => {
    const { before, after, loads } = await openAndIdle({ ...DEFAULT_SETTINGS, effectsVolume: 0 });
    expect(before).toBe(0);
    expect(after).toBe(0);
    expect(loads).toBe(0);
  });
});

describe('the random effect after a flip', () => {
  const deal = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('requestIdleCallback', (task: () => void) => task());
    vi.stubGlobal('cancelIdleCallback', () => {});
    const plays: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      plays.push(this.getAttribute('src') ?? '');
      return Promise.resolve();
    });
    const set = SETS[0];
    const cards = set.cards.slice(0, set.packSize ?? 5).map((card, i) => ({ ...card, uniqueId: i, isRevealed: false, isHolo: false }));
    vi.mocked(openPack).mockResolvedValue({
      setId: set.id, setVersion: set.version, nonce: 0, cards, openedAt: 0,
    } as unknown as Awaited<ReturnType<typeof openPack>>);
    await render(false);
    act(() => document.querySelector<HTMLButtonElement>('.pack-open-button')!.click());
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => {});
    return plays;
  };
  afterEach(() => vi.useRealTimers());

  const flip = () => act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })));

  it('plays the flip at once and the effect EFFECT_DELAY_MS later', async () => {
    const plays = await deal();
    flip();
    expect(plays).toEqual([CARD_FLIP_SRC]);
    await act(async () => { vi.advanceTimersByTime(EFFECT_DELAY_MS - 1); });
    expect(plays).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(plays).toHaveLength(2);
  });

  it('drops an effect still waiting when the pack is closed', async () => {
    const plays = await deal();
    flip();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    act(() => document.querySelector<HTMLButtonElement>('.pack-close')!.click());
    await act(async () => { vi.advanceTimersByTime(EFFECT_DELAY_MS * 2); });
    expect(plays).toEqual([CARD_FLIP_SRC]);
  });

  it('drops an effect still waiting when the opener unmounts', async () => {
    const plays = await deal();
    flip();
    act(() => root.unmount());
    await act(async () => { vi.advanceTimersByTime(EFFECT_DELAY_MS * 2); });
    expect(plays).toEqual([CARD_FLIP_SRC]);
  });
});
