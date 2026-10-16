// @vitest-environment jsdom
import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AchievementToasts, { type ToastItem } from './AchievementToasts';

// The app's own queue: dismissing removes ids, and re-rendering with `paused` pauses it as a big
// pull's showcase does (the queue's state survives the re-render).
const dismissed: string[][] = [];
function Harness({ initial, paused = false }: { initial: ToastItem[]; paused?: boolean }) {
  const [queue, setQueue] = useState(initial);
  const onDismiss = useCallback((ids: string[]) => {
    dismissed.push(ids);
    setQueue((q) => q.filter((t) => !ids.includes(t.id)));
  }, []);
  return <AchievementToasts queue={queue} onDismiss={onDismiss} onOpen={() => {}} paused={paused} />;
}

const kept: ToastItem = { id: 'pack-kept-1', name: 'Pack kept', description: 'Its cards are in Cards', kicker: 'Pack kept', opens: 'collection' };
const levelUp: ToastItem = { id: 'level-2', name: 'Level 2', description: 'New back unlocked', kicker: 'Level up', opens: 'profile' };
const toasts = () => [...document.querySelectorAll('.toast')].map((el) => el.querySelector('.toast-title')?.textContent);

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dismissed.length = 0;
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('notices during a big pull\'s showcase', () => {
  it('hides the toast on screen at once, holds the queue, and shows it all in order afterwards', async () => {
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    expect(toasts()).toEqual(['Pack kept']);

    // Most of the way through its time on screen when the showcase starts.
    await act(() => vi.advanceTimersByTimeAsync(2500));
    act(() => root.render(<Harness initial={[kept, levelUp]} paused />));
    // Gone in the same frame, with no exit fade over the card.
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
    // The region stays, so a held notice is still announced when it shows.
    expect(document.querySelector('.toast-region[role="status"]')).not.toBeNull();

    // Held for as long as the showcase lasts: nothing is shown or dismissed.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
    expect(dismissed).toEqual([]);

    // Afterwards the same notice comes back first, for its full time, and the next follows it.
    act(() => root.render(<Harness initial={[kept, levelUp]} />));
    expect(toasts()).toEqual(['Pack kept']);
    await act(() => vi.advanceTimersByTimeAsync(2900));
    expect(toasts()).toEqual(['Pack kept']);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(dismissed).toEqual([['pack-kept-1']]);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(toasts()).toEqual(['Level 2']);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(dismissed).toEqual([['pack-kept-1'], ['level-2']]);
  });
});
