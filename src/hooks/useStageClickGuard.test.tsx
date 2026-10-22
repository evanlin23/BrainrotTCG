// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAGE_CLICK_GUARD_MS, useStageClickGuard } from './useStageClickGuard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
const action = vi.fn();

const Probe = ({ ms }: { ms?: number }) => {
  const { guard, settling } = useStageClickGuard(ms);
  return <button type="button" data-settling={settling || undefined} onClick={guard(action)}>Act</button>;
};
const button = () => container.querySelector('button')!;

beforeEach(() => {
  vi.useFakeTimers();
  action.mockClear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useStageClickGuard', () => {
  it('ignores clicks from the first render until the window has passed, then lets them through', () => {
    act(() => root.render(<Probe />));
    act(() => button().click());
    expect(action).not.toHaveBeenCalled();
    expect(button().hasAttribute('data-settling')).toBe(true);

    act(() => vi.advanceTimersByTime(STAGE_CLICK_GUARD_MS - 1));
    act(() => button().click());
    expect(action).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(button().hasAttribute('data-settling')).toBe(false);
    act(() => button().click());
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('passes the click through to the action untouched', () => {
    act(() => root.render(<Probe ms={10} />));
    act(() => vi.advanceTimersByTime(10));
    act(() => button().click());
    expect(action.mock.lastCall![0]).toMatchObject({ type: 'click' });
  });

  it('starts a new window for each stage that mounts', () => {
    act(() => root.render(<Probe ms={50} />));
    act(() => vi.advanceTimersByTime(50));
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<Probe ms={50} />));
    act(() => button().click());
    expect(action).not.toHaveBeenCalled();
  });
});
