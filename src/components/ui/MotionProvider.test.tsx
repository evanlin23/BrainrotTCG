// @vitest-environment jsdom
import { useContext } from 'react';
import { act } from 'react';
import { MotionConfigContext } from 'framer-motion';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMotionSetting } from '../../utils/motion';
import MotionProvider from './MotionProvider';

let root: Root;
let reduce = false;
const deviceListeners = new Set<() => void>();
let seen: string[];

const Probe = () => {
  seen.push(useContext(MotionConfigContext).reducedMotion ?? 'unset');
  return null;
};
const setDevice = (value: boolean) => act(() => {
  reduce = value;
  deviceListeners.forEach((listener) => listener());
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  reduce = false;
  seen = [];
  deviceListeners.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && reduce,
    addEventListener: (_: string, listener: () => void) => deviceListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => deviceListeners.delete(listener),
  }));
  root = createRoot(document.createElement('div'));
  act(() => root.render(<MotionProvider><Probe /></MotionProvider>));
});
afterEach(() => {
  act(() => setMotionSetting('auto'));
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('MotionProvider', () => {
  const now = () => seen[seen.length - 1];

  it('lets animations run on Auto when the device allows motion, and calms them when it does not, live', () => {
    expect(now()).toBe('never');
    setDevice(true);
    expect(now()).toBe('always');
    setDevice(false);
    expect(now()).toBe('never');
  });

  it('calms every animation on Reduced whatever the device says, and hands back on Auto', () => {
    act(() => setMotionSetting('reduced'));
    expect(now()).toBe('always');
    setDevice(false);
    expect(now()).toBe('always');
    act(() => setMotionSetting('auto'));
    expect(now()).toBe('never');
  });
});
