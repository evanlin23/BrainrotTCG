// @vitest-environment jsdom
import { StrictMode, act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { readOpenCuePlays } from '../game/openCue';
import { useOpenCue } from './useOpenCue';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let reduce = false;
let latest: ReturnType<typeof useOpenCue>;
let root: Root;

const Probe = ({ enabled }: { enabled: boolean }) => {
  const result = useOpenCue(enabled);
  useEffect(() => { latest = result; });
  return null;
};
const mount = (enabled = true, strict = false) => {
  root = createRoot(document.createElement('div'));
  act(() => root.render(strict ? <StrictMode><Probe enabled={enabled} /></StrictMode> : <Probe enabled={enabled} />));
};
const unmount = () => act(() => root.unmount());

beforeEach(() => {
  reduce = false;
  localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && reduce,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe('useOpenCue', () => {
  it('plays on a new player\'s first two visits, and never a third', () => {
    for (const visit of [1, 2]) {
      mount();
      expect(latest.cue, `visit ${visit}`).toBe('play');
      unmount();
    }
    expect(readOpenCuePlays()).toBe(2);
    mount();
    expect(latest.cue).toBeNull();
  });

  it('counts a visit once, even when React runs its effects twice', () => {
    mount(true, true);
    expect(readOpenCuePlays()).toBe(1);
  });

  it('is a still mark under reduced motion, counted the same way', () => {
    reduce = true;
    mount();
    expect(latest.cue).toBe('still');
    expect(readOpenCuePlays()).toBe(1);
  });

  it('ends when its play runs out, leaving the second play for the next visit', () => {
    mount();
    act(() => latest.end());
    expect(latest.cue).toBeNull();
    unmount();
    mount();
    expect(latest.cue).toBe('play');
  });

  it('stops at the first touch and is done on this device', () => {
    mount();
    act(() => latest.touch());
    expect(latest.cue).toBeNull();
    expect(readOpenCuePlays()).toBe(2);
    unmount();
    mount();
    expect(latest.cue).toBeNull();
  });

  it('never plays, or counts, once a pack is saved', () => {
    mount(false);
    expect(latest.cue).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.OPEN_CUE_PLAYS)).toBeNull();
  });

  it('stops when a pack is saved while it plays', () => {
    mount();
    act(() => root.render(<Probe enabled={false} />));
    expect(latest.cue).toBeNull();
  });

  it('a touch with no cue showing writes nothing', () => {
    mount(false);
    act(() => latest.touch());
    expect(localStorage.getItem(STORAGE_KEYS.OPEN_CUE_PLAYS)).toBeNull();
  });
});
