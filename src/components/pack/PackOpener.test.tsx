// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CARD_FLIP_SRC, EFFECT_DELAY_MS } from '../../constants/audio';
import { SETS } from '../../content/sets';
import { admitOptional, resetAdmission } from '../../game/admission';
import { openPack } from '../../game/pulls';
import { StaleSaveError } from '../../game/player';
import { DEFAULT_SETTINGS } from '../../utils/settings';
import PackOpener from './PackOpener';
import { REFUSAL_COPY } from './refusal';

// The swipe is driven by hand: `cutter.cutting` says whether the player is mid-swipe, `cutter.tear` finishes one,
// and completeCut finishes one the way the real cutter does (the Open pack button calls it).
// Its callbacks are stable, as the real hook's are: the opener's unmount cleanup depends on them.
const cutter = vi.hoisted(() => ({
  cutting: false, tear: () => {}, shortSwipe: () => {}, endCutAttempt: vi.fn(), completeCut: vi.fn(), resetCutState: () => {}, cleanup: () => {},
}));
vi.mock('../../hooks/usePackCutter', () => ({
  usePackCutter: ({ onCutComplete, onShortSwipe }: { onCutComplete: () => void; onShortSwipe?: () => void }) => {
    cutter.tear = onCutComplete;
    cutter.shortSwipe = onShortSwipe ?? (() => {});
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
vi.mock('../../game/pulls', () => ({ openPack: vi.fn(() => new Promise(() => {})), prefetchNextPack: vi.fn(), siteLabel: () => 'example.test/BrainrotTCG' }));
vi.mock('./confettiEffects', () => ({ triggerRarityConfetti: vi.fn(), triggerHoloSparkles: vi.fn() }));
vi.mock('../../game/reload', () => ({ reloadPage: vi.fn() }));

let root: Root;
// An opener that unmounts mid-pack steps browser history back over the pack's entry, and jsdom delivers that
// a couple of timer turns later as a popstate. Left to arrive on its own it lands in a later test, where it
// reads as the player pressing Back: that test's pack ends and its sounds are cleaned up. So every test
// counts the steps it took and the popstates that came of them, and waits for them all before it ends.
let stepsBack: MockInstance<typeof history.back>;
let popstates = 0;
let popstated = () => {};
const countPopstate = () => {
  popstates += 1;
  popstated();
};

/** The save the tab loaded, which every tear binds its claim to. */
const MOUNTED_SAVE = { key: 'ab'.repeat(32), stored: true, stamp: null };
const render = (disabled: boolean, openBlocked = false, settings = DEFAULT_SETTINGS) =>
  act(() => root.render(
    <PackOpener onOpen={() => {}} onShare={() => {}} set={SETS[0]} settings={settings} disabled={disabled} openBlocked={openBlocked} mountedSave={MOUNTED_SAVE} />,
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
  popstates = 0;
  popstated = () => {};
  window.addEventListener('popstate', countPopstate);
  stepsBack = vi.spyOn(history, 'back');
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(async () => {
  act(() => root.unmount());
  // jsdom's traversal runs on real timers, which a test may still have faked.
  vi.useRealTimers();
  while (popstates < stepsBack.mock.calls.length) await new Promise<void>((resolve) => { popstated = resolve; });
  window.removeEventListener('popstate', countPopstate);
  stepsBack.mockRestore();
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
  const openButton = () => $<HTMLElement>('[data-pack-open]');
  const retryButton = () => $<HTMLButtonElement>('.pack-retry-button');
  const announced = () => $('.pack-opener-container > [aria-live="polite"]')?.textContent;
  /** Past the tear's 460ms pause, to where the ticket is asked for, and let a refused one settle. */
  const pastTheTear = async () => {
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => {});
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => vi.useRealTimers());

  it('opens the pack with one press, through the same cut and ticket as a swipe', async () => {
    await render(false);
    // The pack is the one control: named for its set, a Tab stop, no other Open pack button.
    expect(openButton()).toBe($('.pack-shell'));
    expect(openButton()?.getAttribute('role')).toBe('button');
    expect(openButton()?.getAttribute('aria-label')).toBe(`Open pack, ${SETS[0].name}`);
    expect(openButton()?.tabIndex).toBe(0);
    expect(document.querySelectorAll('button')).toHaveLength(0);

    act(() => openButton()!.click());
    expect(cutter.completeCut).toHaveBeenCalledOnce();
    // Torn: it says so, and a second press does nothing while the ticket is on its way.
    expect(openButton()?.getAttribute('aria-disabled')).toBe('true');
    expect(openButton()?.getAttribute('aria-label')).toBe('Opening…');
    act(() => openButton()!.click());
    expect(cutter.completeCut).toHaveBeenCalledOnce();

    await pastTheTear();
    expect(openPack).toHaveBeenCalledOnce();
    expect(openPack).toHaveBeenCalledWith(SETS[0], MOUNTED_SAVE);
  });

  it('answers a swipe let go short with a spring-back and a hint, then still opens with a tap (#803)', async () => {
    await render(false);
    const shell = $('.pack-shell')!;
    const hint = () => $('.swipe-hint-text')?.textContent;
    expect(hint()).toBe('Drag across, or click');
    expect(shell.classList.contains('is-short')).toBe(false);

    act(() => cutter.shortSwipe());
    expect(shell.classList.contains('is-short')).toBe(true);
    expect(hint()).toBe('Drag farther, or click the pack');

    // The feedback lasts a moment, then the usual cue is back.
    await act(async () => { vi.advanceTimersByTime(1900); });
    expect(shell.classList.contains('is-short')).toBe(false);
    expect(hint()).toBe('Drag across, or click');

    // And the tap the hint names opens the pack.
    act(() => cutter.shortSwipe());
    act(() => openButton()!.click());
    expect(cutter.completeCut).toHaveBeenCalledOnce();
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
    // The pack stays tappable too, but the player's place moved to Try again, not the page.
    expect(document.activeElement).toBe(retryButton());

    act(() => retryButton()!.click());
    expect(cutter.completeCut).toHaveBeenCalledTimes(2);
    expect($('.pack-refusal-text')).toBeNull();
    expect(announced()).toBe('');
    // Try again went with the refusal: focus is on the pack, torn again, not the page.
    expect(retryButton()).toBeNull();
    expect(document.activeElement).toBe(openButton());
    await pastTheTear();
    expect(openPack).toHaveBeenCalledTimes(2);
  });

  it('says the save changed and stays sealed when openPack rejects with StaleSaveError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(openPack).mockRejectedValueOnce(new StaleSaveError());
    await render(false);
    openButton()!.focus();
    act(() => openButton()!.click());
    await pastTheTear();

    expect($('.pack-refusal-text')?.textContent).toBe(REFUSAL_COPY.blocked.message);
    expect(announced()).toBe(REFUSAL_COPY.blocked.message);
    expect(retryButton()?.textContent).toBe(REFUSAL_COPY.blocked.action);
    await act(async () => { vi.advanceTimersByTime(100); });
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
      act(() => document.querySelector<HTMLElement>('[data-pack-open]')!.click());
      await act(async () => { vi.advanceTimersByTime(500); });
      await act(async () => {});
      // Dealt, and the reveal is drawn while the torn pack is still leaving, with no empty stage between.
      expect(openPack).toHaveBeenCalledOnce();
      expect(document.querySelector('.card-reveal-area .reveal-card')).not.toBeNull();
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

describe('the sealed pack stage on a desktop window', () => {
  it('goes back to the top as the cards come in, so the reveal inherits no scroll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const set = SETS[0];
    const cards = set.cards.slice(0, set.packSize ?? 5).map((card, i) => ({ ...card, uniqueId: i, isRevealed: false, isHolo: false }));
    vi.mocked(openPack).mockResolvedValue({
      setId: set.id, setVersion: set.version, nonce: 0, cards, openedAt: 0,
    } as unknown as Awaited<ReturnType<typeof openPack>>);
    try {
      await render(false);
      // The stage scrolls here (PackOpener.css); the player has wheeled down to the bottom of the pack.
      const stage = document.querySelector<HTMLElement>('.pack-display')!;
      stage.scrollTop = 420;
      expect(stage.scrollTop).toBe(420);

      act(() => document.querySelector<HTMLElement>('[data-pack-open]')!.click());
      // Tearing and waiting on the ticket leave the stage where the player scrolled it.
      expect(stage.scrollTop).toBe(420);
      await act(async () => { vi.advanceTimersByTime(500); });
      await act(async () => {});
      expect(document.querySelector('.card-reveal-area .reveal-card')).not.toBeNull();
      expect(stage.scrollTop).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the random effect after a flip', () => {
  const deal = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('requestIdleCallback', (task: () => void) => task());
    vi.stubGlobal('cancelIdleCallback', () => {});
    const plays: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    // jsdom has no pause; leaving a pack or unmounting now pauses the clones still playing.
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      plays.push(this.getAttribute('src') ?? '');
      return Promise.resolve();
    });
    const set = SETS[0];
    const cards = set.cards.slice(0, set.packSize ?? 5).map((card, i) => ({ ...card, uniqueId: i, isRevealed: false, isHolo: false }));
    vi.mocked(openPack).mockResolvedValue({
      setId: set.id, setVersion: set.version, nonce: 0, cards, openedAt: 0,
    } as unknown as Awaited<ReturnType<typeof openPack>>);
    await render(false);
    act(() => document.querySelector<HTMLElement>('[data-pack-open]')!.click());
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => {});
    return { plays, pause, play };
  };
  afterEach(() => vi.useRealTimers());

  const flip = () => act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })));

  it('plays the flip at once and the effect EFFECT_DELAY_MS later', async () => {
    const { plays } = await deal();
    flip();
    expect(plays).toEqual([CARD_FLIP_SRC]);
    await act(async () => { vi.advanceTimersByTime(EFFECT_DELAY_MS - 1); });
    expect(plays).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(plays).toHaveLength(2);
  });

  it('drops an effect still waiting when the pack is closed', async () => {
    const { plays } = await deal();
    flip();
    act(() => document.querySelector<HTMLButtonElement>('.pack-close')!.click());
    await act(async () => { vi.advanceTimersByTime(EFFECT_DELAY_MS * 2); });
    expect(plays).toEqual([CARD_FLIP_SRC]);
  });

  it('stops and releases the playing flip clone when the pack is closed', async () => {
    const { pause, play } = await deal();
    flip();
    const [clone] = play.mock.contexts as HTMLAudioElement[];
    expect(clone.getAttribute('src')).toBe(CARD_FLIP_SRC);
    expect(pause.mock.contexts).not.toContain(clone);
    act(() => document.querySelector<HTMLButtonElement>('.pack-close')!.click());
    await act(async () => { vi.advanceTimersByTime(EFFECT_DELAY_MS * 2); });
    expect((pause.mock.contexts as unknown[]).filter((el) => el === clone)).toHaveLength(1);
    expect(clone.getAttribute('src')).toBe('');
  });

  it('stops the playing flip clone when the opener unmounts', async () => {
    const { pause, play } = await deal();
    flip();
    const [clone] = play.mock.contexts as HTMLAudioElement[];
    act(() => root.unmount());
    await act(async () => { vi.advanceTimersByTime(EFFECT_DELAY_MS * 2); });
    expect((pause.mock.contexts as unknown[]).filter((el) => el === clone)).toHaveLength(1);
    expect(clone.getAttribute('src')).toBe('');
  });

  it('drops an effect still waiting when the opener unmounts', async () => {
    const { plays } = await deal();
    flip();
    act(() => root.unmount());
    await act(async () => { vi.advanceTimersByTime(EFFECT_DELAY_MS * 2); });
    expect(plays).toEqual([CARD_FLIP_SRC]);
  });
});

describe('one record per pack, whatever order the player and the ticket arrive in', () => {
  const set = SETS[0];
  const cards = set.cards.slice(0, set.packSize ?? 5).map((card, i) => ({ ...card, uniqueId: i, isRevealed: false, isHolo: false }));
  const dealt = { setId: set.id, setVersion: set.version, nonce: 0, cards, openedAt: 0 } as unknown as Awaited<ReturnType<typeof openPack>>;
  const onOpen = vi.fn();
  const onLeaveEarly = vi.fn();
  const show = () => act(() => root.render(
    <PackOpener onOpen={onOpen} onShare={() => {}} onLeaveEarly={onLeaveEarly} set={set} settings={DEFAULT_SETTINGS} mountedSave={MOUNTED_SAVE} />,
  ));
  const press = (code: string, key: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true }));
  /** Tears the pack and lets the 460ms pause pass, so the ticket is being asked for. */
  const tear = async () => {
    act(() => document.querySelector<HTMLElement>('[data-pack-open]')!.click());
    await act(async () => { vi.advanceTimersByTime(500); });
  };
  /** The ticket lands when the test says so: `land()` resolves it, outside act. */
  const holdTicketUntil = () => {
    let land = () => {};
    vi.mocked(openPack).mockImplementation(() => new Promise((resolve) => { land = () => resolve(dealt); }));
    return () => land();
  };
  /** The same, landing inside act. */
  const holdTicket = () => {
    const land = holdTicketUntil();
    return () => act(async () => { land(); });
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('requestIdleCallback', () => 0);
    vi.stubGlobal('cancelIdleCallback', () => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    onOpen.mockReset();
    onLeaveEarly.mockReset();
  });
  afterEach(() => {
    // jsdom queues a history step on the faked timers, in more than one turn: run them all before the real ones come back.
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('records a pack left mid-reveal once, even when two leaves arrive before React renders', async () => {
    vi.mocked(openPack).mockResolvedValue(dealt);
    await show();
    await tear();
    await act(async () => {});
    expect(document.querySelector('.card-reveal-area .reveal-card')).not.toBeNull();

    act(() => {
      press('Escape', 'Escape');
      press('Escape', 'Escape');
    });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0][0].cards.every((card: { isRevealed: boolean }) => card.isRevealed)).toBe(true);
    expect(onLeaveEarly).toHaveBeenCalledOnce();
    expect(document.querySelector('.card-reveal-area')).toBeNull();
  });

  /** The ticket lands and `during` runs before React renders what the landing queued. */
  const landThen = (land: () => Promise<void> | void, during: () => void) => act(async () => {
    land();
    // The opener has dealt the pack once its await continues; nothing has rendered, as act holds the render back.
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    during();
  });
  it('records a pack the player leaves in the gap between its ticket landing and the reveal rendering', async () => {
    const made: HTMLAudioElement[] = [];
    const RealAudio = window.Audio;
    vi.stubGlobal('Audio', class extends RealAudio {
      constructor(src?: string) {
        super(src);
        made.push(this);
      }
    });
    const land = holdTicketUntil();
    await show();
    await tear();
    let madeInGap = 0;
    let readyInGap = false;
    await landThen(land, () => {
      // The sounds were fetched when the pack was dealt, before anything rendered: this is the gap.
      madeInGap = made.length;
      readyInGap = made.every((audio) => audio.getAttribute('src'));
      press('Escape', 'Escape');
    });

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0][0].cards.every((card: { isRevealed: boolean }) => card.isRevealed)).toBe(true);
    // Nothing was turned over yet: it is kept, with the notice saying where its cards went.
    expect(onLeaveEarly).toHaveBeenCalledOnce();
    expect(document.querySelector('.card-reveal-area')).toBeNull();
    // The sounds loaded for the reveal that never showed are released, not left fetching.
    expect(madeInGap).toBeGreaterThan(0);
    expect(readyInGap).toBe(true);
    expect(made.every((audio) => audio.getAttribute('src') === '')).toBe(true);
  });

  it('records a pack whose opener unmounts in the gap between its ticket landing and the reveal rendering', async () => {
    const land = holdTicketUntil();
    await show();
    await tear();
    await landThen(land, () => root.unmount());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('keeps a pack whose ticket lands after the player left, once', async () => {
    const land = holdTicket();
    await show();
    await tear();
    act(() => {
      press('Escape', 'Escape');
      press('Escape', 'Escape');
    });
    // Back on the packs screen, nothing dealt yet.
    expect(document.querySelector('.card-reveal-area')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();

    await land();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onLeaveEarly).toHaveBeenCalledOnce();
    expect(document.querySelector('.card-reveal-area')).toBeNull();
  });

  it('keeps a pack whose ticket lands after the opener unmounted', async () => {
    const land = holdTicket();
    await show();
    await tear();
    act(() => root.unmount());
    expect(onOpen).not.toHaveBeenCalled();

    await land();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0][0].nonce).toBe(0);
  });

  it('records a pack still being revealed when the opener unmounts, once', async () => {
    vi.mocked(openPack).mockResolvedValue(dealt);
    await show();
    await tear();
    await act(async () => {});
    act(() => root.unmount());
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
