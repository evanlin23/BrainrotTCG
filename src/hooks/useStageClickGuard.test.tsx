// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAGE_CLICK_GUARD_MS, STAGE_PRIMARY_ATTR, useStageClickGuard } from './useStageClickGuard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
const action = vi.fn();

const primary = vi.fn();

const Probe = ({ ms, active }: { ms?: number; active?: boolean }) => {
  const { blockClicks, settling } = useStageClickGuard(ms, active);
  return (
    <div data-settling={settling || undefined} onClickCapture={blockClicks}>
      <button type="button" onClick={action}>Act</button>
      <button type="button" onClick={primary} {...{ [STAGE_PRIMARY_ATTR]: true }}><span>Go</span></button>
    </div>
  );
};
const button = () => container.querySelector('button')!;
const go = () => container.querySelector<HTMLElement>('button span')!;
const stage = () => container.firstElementChild!;

beforeEach(() => {
  vi.useFakeTimers();
  action.mockClear();
  primary.mockClear();
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
    expect(stage().hasAttribute('data-settling')).toBe(true);

    act(() => vi.advanceTimersByTime(STAGE_CLICK_GUARD_MS - 1));
    act(() => button().click());
    expect(action).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(stage().hasAttribute('data-settling')).toBe(false);
    act(() => button().click());
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('never holds an element marked as the stage\'s primary move, or anything inside it', () => {
    act(() => root.render(<Probe />));
    act(() => go().click());
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it('passes the click through to the action untouched', () => {
    act(() => root.render(<Probe ms={10} />));
    act(() => vi.advanceTimersByTime(10));
    act(() => button().click());
    expect(action.mock.lastCall![0]).toMatchObject({ type: 'click' });
  });

  it('with active, holds nothing until the stage is up, then runs the window from that render', () => {
    act(() => root.render(<Probe ms={50} active={false} />));
    act(() => vi.advanceTimersByTime(500));
    expect(stage().hasAttribute('data-settling')).toBe(false);
    act(() => button().click());
    expect(action).toHaveBeenCalledTimes(1);

    act(() => root.render(<Probe ms={50} active />));
    expect(stage().hasAttribute('data-settling')).toBe(true);
    act(() => button().click());
    expect(action).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(49));
    expect(stage().hasAttribute('data-settling')).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(stage().hasAttribute('data-settling')).toBe(false);

    act(() => root.render(<Probe ms={50} active={false} />));
    act(() => root.render(<Probe ms={50} active />));
    expect(stage().hasAttribute('data-settling')).toBe(true);
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

  it('leaves no timer behind when the stage goes away inside its window', () => {
    act(() => root.render(<Probe />));
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
