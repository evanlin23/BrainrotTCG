// @vitest-environment jsdom
import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_SEEN_MS } from '../../constants/toast';
import AchievementToasts, { GROUPED_TOAST_MS, TOAST_MS, type ToastItem } from './AchievementToasts';

// The real framer-motion, except that the toast's drag handlers are kept, so a swipe can be played into it
// (jsdom has no pointer gestures to drag with).
const drag: { onDrag?: (event: unknown, info: unknown) => void; onDragEnd?: (event: unknown, info: unknown) => void } = {};
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  const { createElement, forwardRef } = await import('react');
  const Div = actual.motion.div;
  const Spy = forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
    drag.onDrag = props.onDrag as typeof drag.onDrag;
    drag.onDragEnd = props.onDragEnd as typeof drag.onDragEnd;
    return createElement(Div, { ...props, ref });
  });
  return { ...actual, motion: { ...actual.motion, div: Spy } };
});

// The app's own queue: dismissing removes ids, and re-rendering with `held` holds it as a big pull's
// showcase does, or with `paused` as an open sheet does (the queue's state survives the re-render).
const dismissed: string[][] = [];
const opened: string[] = [];
function Harness({ initial, paused = false, held = false }: { initial: ToastItem[]; paused?: boolean; held?: boolean }) {
  const [queue, setQueue] = useState(initial);
  const onDismiss = useCallback((ids: string[]) => {
    dismissed.push(ids);
    setQueue((q) => q.filter((t) => !ids.includes(t.id)));
  }, []);
  return <AchievementToasts queue={queue} onDismiss={onDismiss} onOpen={(target) => opened.push(target)} paused={paused} held={held} />;
}

const kept: ToastItem = { id: 'pack-kept-1', name: 'Pack kept', description: 'Its cards are in Cards', kicker: 'Pack kept', opens: 'collection' };
const levelUp: ToastItem = { id: 'level-2', name: 'Level 2', description: 'New back unlocked', kicker: 'Level up', opens: 'profile' };
// Says whether the focus the test gives a button counts as the keyboard's. jsdom 27+ (which swapped nwsapi for
// @asamuzakjp/dom-selector) works :focus-visible out from the last key or mouse event and the last focus, so a
// click made on the button or an earlier test's click decides it; jsdom 26 matched any focused element.
const focusVisibleIs = (visible: boolean) => {
  const matches = HTMLElement.prototype.matches;
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector: string) {
    return selector === ':focus-visible' ? visible : matches.call(this, selector);
  });
};
const toasts = () => [...document.querySelectorAll('.toast')].map((el) => el.querySelector('.toast-title')?.textContent);

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  dismissed.length = 0;
  opened.length = 0;
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  // Let framer-motion's frame loop run out on the fake clock, or the next test's animations never start.
  vi.advanceTimersByTime(100);
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('notices during a big pull\'s showcase', () => {
  it('hides the toast on screen at once, holds the queue, and shows it all in order afterwards', async () => {
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    expect(toasts()).toEqual(['Pack kept']);

    // Most of the way through its time on screen when the showcase starts.
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS - 500));
    act(() => root.render(<Harness initial={[kept, levelUp]} held />));
    // Gone in the same frame, with no exit fade over the card.
    expect(document.querySelectorAll('.toast')).toHaveLength(0);

    // Held for as long as the showcase lasts: nothing is shown or dismissed.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
    expect(dismissed).toEqual([]);

    // Afterwards the same notice comes back first, for its full time, and the next follows it.
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    expect(toasts()).toEqual(['Pack kept']);
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS - 100));
    expect(toasts()).toEqual(['Pack kept']);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(dismissed).toEqual([['pack-kept-1']]);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(toasts()).toEqual(['Level 2']);
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS));
    expect(dismissed).toEqual([['pack-kept-1'], ['level-2']]);
  });
});

describe('notices while a sheet, page or pack is open', () => {
  it('lets a toast the player has seen go, and shows the next one in full afterwards', async () => {
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    await act(() => vi.advanceTimersByTimeAsync(TOAST_SEEN_MS + 100));
    act(() => root.render(<Harness initial={[kept, levelUp]} paused />));
    // Still there as it fades, but a tap on it no longer counts: it has gone back to the queue or out.
    expect(toasts()).toEqual(['Pack kept']);
    act(() => document.querySelector<HTMLElement>('.toast-open')!.click());
    expect(opened).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(dismissed).toEqual([['pack-kept-1']]);

    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(toasts()).toEqual(['Level 2']);
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS - 400));
    expect(toasts()).toEqual(['Level 2']);
  });

  it('brings back, in full, a toast the player had barely seen', async () => {
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    await act(() => vi.advanceTimersByTimeAsync(TOAST_SEEN_MS - 500));
    act(() => root.render(<Harness initial={[kept, levelUp]} paused />));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
    expect(dismissed).toEqual([]);

    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(toasts()).toEqual(['Pack kept']);
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS - 400));
    expect(toasts()).toEqual(['Pack kept']);
    act(() => document.querySelector<HTMLElement>('.toast-open')!.click());
    expect(opened).toEqual(['collection']);
    expect(dismissed).toEqual([['pack-kept-1']]);
  });

  it('lets a seen grouped toast go as one, with all its ids', async () => {
    const run = [1, 2, 3].map((n): ToastItem => ({ id: `a${n}`, name: `Achievement ${n}`, description: 'Done' }));
    act(() => root.render(<Harness initial={run} />));
    await act(() => vi.advanceTimersByTimeAsync(TOAST_SEEN_MS + 100));
    act(() => root.render(<Harness initial={run} paused />));
    expect(dismissed).toEqual([['a1', 'a2', 'a3']]);
  });
});

describe('dismissing a toast with the keyboard', () => {
  it('lets Escape on the focused toast send it away without opening it, and leaves the next', async () => {
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    const toast = document.querySelector<HTMLElement>('.toast-open')!;
    act(() => toast.focus());
    const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => toast.dispatchEvent(key));
    expect(dismissed).toEqual([['pack-kept-1']]);
    expect(opened).toEqual([]);
    // The pack's own Escape sees it was taken.
    expect(key.defaultPrevented).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(toasts()).toEqual(['Level 2']);
  });
});

describe('swiping a toast away', () => {
  const thrown = { offset: { x: 120, y: 0 }, velocity: { x: 900, y: 0 } };

  it('does not leave the next toast deaf to its first tap, which a screen reader makes with no press before it', async () => {
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    act(() => {
      drag.onDrag!(null, thrown);
      drag.onDragEnd!(null, thrown);
    });
    expect(dismissed).toEqual([['pack-kept-1']]);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(toasts()).toEqual(['Level 2']);
    // No pointerdown or key first: the toast is activated as an assistive technology does.
    act(() => document.querySelector<HTMLElement>('.toast-open')!.click());
    expect(opened).toEqual(['profile']);
    expect(dismissed).toEqual([['pack-kept-1'], ['level-2']]);
  });

  it('still swallows the click that ends a swipe which stopped short, once', () => {
    act(() => root.render(<Harness initial={[kept]} />));
    const short = { offset: { x: 30, y: 0 }, velocity: { x: 0, y: 0 } };
    act(() => {
      drag.onDrag!(null, short);
      drag.onDragEnd!(null, short);
    });
    act(() => document.querySelector<HTMLElement>('.toast-open')!.click());
    expect(opened).toEqual([]);
    expect(dismissed).toEqual([]);
    act(() => document.querySelector<HTMLElement>('.toast-open')!.click());
    expect(opened).toEqual(['collection']);
  });
});

describe('where the focus goes when the keyboard dismisses a toast', () => {
  const dismissButton = () => document.querySelector<HTMLButtonElement>('button.toast-dismiss')!;
  // Outside the toasts' own root, which clears what it was given.
  const outside = () => document.body.appendChild(document.createElement('button'));
  afterEach(() => document.querySelectorAll('body > button').forEach((el) => el.remove()));
  const before = () => {
    const button = outside();
    act(() => button.focus());
    return button;
  };

  it('hands it back to the element that had it before the toast took it, from its X', () => {
    focusVisibleIs(true);
    const origin = before();
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    act(() => dismissButton().focus());
    expect(document.activeElement).toBe(dismissButton());
    act(() => dismissButton().click());
    expect(dismissed).toEqual([['pack-kept-1']]);
    expect(document.activeElement).toBe(origin);
  });

  it('does the same for Escape on the body', () => {
    const origin = before();
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    const toast = document.querySelector<HTMLElement>('.toast-open')!;
    act(() => toast.focus());
    act(() => toast.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(origin);
  });

  it('leaves focus alone when the toast did not have it (a tap, or a toast timing out)', async () => {
    const origin = before();
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    expect(document.activeElement).toBe(origin);
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS));
    expect(document.activeElement).toBe(origin);
  });

  it('does not pull focus back from where the player moved it since', () => {
    before();
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    act(() => dismissButton().focus());
    const elsewhere = outside();
    act(() => elsewhere.focus());
    act(() => dismissButton().click());
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('the dismiss control', () => {
  const dismissButton = () => document.querySelector<HTMLButtonElement>('button.toast-dismiss')!;

  it('has an accessible name, and only dismisses: nothing is opened', async () => {
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    expect(dismissButton().getAttribute('aria-label')).toBe('Dismiss');
    act(() => dismissButton().click());
    expect(dismissed).toEqual([['pack-kept-1']]);
    expect(opened).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(toasts()).toEqual(['Level 2']);
  });

  it('dismisses a whole grouped toast with all its ids', () => {
    const run = [1, 2, 3].map((n): ToastItem => ({ id: `a${n}`, name: `Achievement ${n}`, description: 'Done' }));
    act(() => root.render(<Harness initial={run} />));
    act(() => dismissButton().click());
    expect(dismissed).toEqual([['a1', 'a2', 'a3']]);
    expect(opened).toEqual([]);
  });

  it('is separate from the body, which opens the toast\'s target and dismisses it too', () => {
    act(() => root.render(<Harness initial={[levelUp]} />));
    expect(document.querySelectorAll('.toast button')).toHaveLength(2);
    act(() => document.querySelector<HTMLElement>('.toast-open')!.click());
    expect(opened).toEqual(['profile']);
    expect(dismissed).toEqual([['level-2']]);
  });

  it('does nothing on a toast already fading out', () => {
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    const button = dismissButton();
    act(() => root.render(<Harness initial={[kept, levelUp]} paused />));
    act(() => button.click());
    expect(opened).toEqual([]);
  });
});

describe('how long a toast stays up (#718)', () => {
  const achievement = (n: number): ToastItem => ({ id: `a${n}`, name: `Achievement ${n}`, description: 'Done' });

  it('gives a single toast time to read and tap: 5 seconds, and it is still tappable late', async () => {
    // Pinned: the owner found 8 and 10 seconds too long on a phone.
    expect(TOAST_MS).toBe(5000);
    expect(GROUPED_TOAST_MS).toBe(6000);
    expect(TOAST_SEEN_MS).toBeLessThan(TOAST_MS);
    act(() => root.render(<Harness initial={[levelUp]} />));
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS - 100));
    expect(dismissed).toEqual([]);
    act(() => document.querySelector<HTMLElement>('.toast-open')!.click());
    expect(opened).toEqual(['profile']);
  });

  it('gives the next toast its full time from when it appears, not from when the previous toast started exiting', async () => {
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    expect(toasts()).toEqual(['Pack kept']);
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS));
    expect(dismissed).toEqual([['pack-kept-1']]);

    // Let the previous toast finish its 180ms exit animation
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(toasts()).toEqual(['Level 2']);

    // It should still be up TOAST_MS - 100 after appearing
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS - 100));
    expect(dismissed).toEqual([['pack-kept-1']]);

    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(dismissed).toEqual([['pack-kept-1'], ['level-2']]);
  });

  // The toast being replaced stays mounted for its 180ms exit, and its timer must not outlive it.
  describe('while a toast is leaving', () => {
    const dismissButton = () => document.querySelector<HTMLButtonElement>('button.toast-dismiss')!;

    it('still dismisses a toast that returns inside the exit window of a pause', async () => {
      act(() => root.render(<Harness initial={[kept]} />));
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(toasts()).toEqual(['Pack kept']);
      act(() => root.render(<Harness initial={[kept]} paused />));
      await act(() => vi.advanceTimersByTimeAsync(40));
      act(() => root.render(<Harness initial={[kept]} />));
      await act(() => vi.advanceTimersByTimeAsync(TOAST_MS + 1000));
      expect(dismissed).toEqual([['pack-kept-1']]);
    });

    it('does not dismiss a toast a second time when its timer would have fired mid-exit', async () => {
      act(() => root.render(<Harness initial={[kept, levelUp]} />));
      await act(() => vi.advanceTimersByTimeAsync(TOAST_MS - 60));
      act(() => dismissButton().click());
      expect(dismissed).toEqual([['pack-kept-1']]);
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(dismissed).toEqual([['pack-kept-1']]);
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(toasts()).toEqual(['Level 2']);
    });

    it('does not let the old key\'s timer drop its ids when another unlock changes the key, mid-exit', async () => {
      const item = (n: number): ToastItem => ({ id: `a${n}`, name: `Achievement ${n}`, description: 'Done' });
      const onDismiss = vi.fn();
      const render = (queue: ToastItem[]) => act(() => root.render(<AchievementToasts queue={queue} onDismiss={onDismiss} onOpen={() => {}} />));
      render([item(1), item(2), item(3)]);
      await act(() => vi.advanceTimersByTimeAsync(GROUPED_TOAST_MS - 60));
      // A fourth unlock changes the grouped toast's key, so the one up leaves and the new one replaces it.
      render([item(1), item(2), item(3), item(4)]);
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(onDismiss).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(toasts()).toEqual(['Achievement 1, Achievement 2, Achievement 3 +1 more']);
      await act(() => vi.advanceTimersByTimeAsync(GROUPED_TOAST_MS));
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(onDismiss).toHaveBeenCalledWith(['a1', 'a2', 'a3', 'a4']);
    });
  });

  it('gives a grouped toast longer than a single one', async () => {
    act(() => root.render(<Harness initial={[achievement(1), achievement(2), achievement(3)]} />));
    await act(() => vi.advanceTimersByTimeAsync(GROUPED_TOAST_MS - 100));
    expect(dismissed).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(dismissed).toEqual([['a1', 'a2', 'a3']]);
  });

  it('waits while the pointer is on it, then gives it its full time again', async () => {
    act(() => root.render(<Harness initial={[levelUp]} />));
    const toast = () => document.querySelector<HTMLElement>('.toast')!;
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS - 100));
    act(() => toast().dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS * 3));
    expect(dismissed).toEqual([]);
    expect(toasts()).toEqual(['Level 2']);
    act(() => toast().dispatchEvent(new MouseEvent('pointerout', { bubbles: true })));
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS - 100));
    expect(dismissed).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(dismissed).toEqual([['level-2']]);
  });

  it('waits while it has keyboard focus, and not after focus leaves', async () => {
    focusVisibleIs(true);
    act(() => root.render(<Harness initial={[levelUp]} />));
    act(() => document.querySelector<HTMLElement>('.toast-open')!.focus());
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS * 3));
    expect(dismissed).toEqual([]);
    act(() => document.querySelector<HTMLElement>('.toast-open')!.blur());
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS));
    expect(dismissed).toEqual([['level-2']]);
  });

  it('is not held by focus a tap or swipe left on it, only by focus from the keyboard', async () => {
    // Focus a pointer gives the button does not match :focus-visible.
    focusVisibleIs(false);
    act(() => root.render(<Harness initial={[levelUp]} />));
    act(() => document.querySelector<HTMLElement>('.toast-open')!.focus());
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS));
    expect(dismissed).toEqual([['level-2']]);
  });

  it('does not stay held after a sheet hides a toast the pointer was on', async () => {
    act(() => root.render(<Harness initial={[levelUp]} />));
    act(() => document.querySelector<HTMLElement>('.toast')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    act(() => root.render(<Harness initial={[levelUp]} held />));
    act(() => root.render(<Harness initial={[levelUp]} />));
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS));
    expect(dismissed).toEqual([['level-2']]);
  });
});
