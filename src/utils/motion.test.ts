import { afterEach, describe, expect, it, vi } from 'vitest';
import { buzz, prefersReducedMotion, REDUCED_MOTION_QUERY } from './motion';

const preferLessMotion = (reduce: boolean) =>
  vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: reduce && query === REDUCED_MOTION_QUERY }) });

afterEach(() => vi.unstubAllGlobals());

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
