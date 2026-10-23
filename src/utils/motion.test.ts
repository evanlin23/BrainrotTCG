import { afterEach, describe, expect, it, vi } from 'vitest';
import { buzz, prefersReducedMotion, REDUCED_MOTION_QUERY, setMotionSetting, subscribeReducedMotion } from './motion';

const preferLessMotion = (reduce: boolean) =>
  vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: reduce && query === REDUCED_MOTION_QUERY }) });

afterEach(() => {
  setMotionSetting('auto');
  vi.unstubAllGlobals();
});

describe('reduced motion', () => {
  it('follows the device setting, and reads as off where it cannot be asked', () => {
    preferLessMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    preferLessMotion(false);
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal('window', {});
    expect(prefersReducedMotion()).toBe(false);
  });

  it('buzzes only when the device vibrates and allows motion', () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal('navigator', { vibrate });
    preferLessMotion(false);
    buzz([18, 60, 30]);
    expect(vibrate).toHaveBeenCalledExactlyOnceWith([18, 60, 30]);

    preferLessMotion(true);
    buzz(8);
    expect(vibrate).toHaveBeenCalledOnce();

    vi.stubGlobal('navigator', {});
    preferLessMotion(false);
    expect(() => buzz(8)).not.toThrow();
  });
});

describe('the Motion setting', () => {
  it('makes motion calm whatever the device says, and hands back to the device on Auto', () => {
    preferLessMotion(false);
    setMotionSetting('reduced');
    expect(prefersReducedMotion()).toBe(true);
    setMotionSetting('auto');
    expect(prefersReducedMotion()).toBe(false);
    preferLessMotion(true);
    expect(prefersReducedMotion()).toBe(true); // Auto follows the device
    setMotionSetting('reduced');
    expect(prefersReducedMotion()).toBe(true);
  });

  it('marks <html> for the stylesheet, writing it only when it changes', () => {
    const dataset: Record<string, string> = {};
    const writes: string[] = [];
    vi.stubGlobal('document', { documentElement: { dataset: new Proxy(dataset, {
      set: (target, key, value) => { writes.push(`set ${String(key)}=${value}`); target[key as string] = value; return true; },
      deleteProperty: (target, key) => { writes.push(`delete ${String(key)}`); delete target[key as string]; return true; },
    }) } });
    setMotionSetting('reduced');
    setMotionSetting('reduced');
    expect(dataset).toEqual({ motion: 'reduced' });
    setMotionSetting('auto');
    setMotionSetting('auto');
    expect(dataset).toEqual({});
    expect(writes).toEqual(['set motion=reduced', 'delete motion']);
  });

  it('stops buzzing once Reduced is chosen on a device that allows motion', () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal('navigator', { vibrate });
    preferLessMotion(false);
    setMotionSetting('reduced');
    buzz(8);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('tells subscribers when the setting or the device changes, and stops after cleanup', () => {
    const deviceListeners = new Set<() => void>();
    vi.stubGlobal('window', { matchMedia: () => ({
      matches: false,
      addEventListener: (_: string, listener: () => void) => deviceListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => deviceListeners.delete(listener),
    }) });
    const onChange = vi.fn();
    const stop = subscribeReducedMotion(onChange);
    setMotionSetting('reduced');
    expect(onChange).toHaveBeenCalledTimes(1);
    setMotionSetting('reduced'); // unchanged: nothing to tell
    expect(onChange).toHaveBeenCalledTimes(1);
    deviceListeners.forEach((listener) => listener());
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    expect(deviceListeners.size).toBe(0);
    setMotionSetting('auto');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
