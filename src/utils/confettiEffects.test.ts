import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import confetti from 'canvas-confetti';
import { triggerCardEffects, triggerHoloSparkles, triggerRarityConfetti } from './confettiEffects';

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

let reduce = false;
beforeEach(() => {
  reduce = false;
  vi.mocked(confetti).mockClear();
  vi.useFakeTimers();
  vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)' }) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('confetti and reduced motion', () => {
  it('bursts for big rarities and holo cards when motion is allowed', () => {
    triggerRarityConfetti('LEGENDARY');
    expect(confetti).toHaveBeenCalledOnce();
    triggerRarityConfetti('COMMON');
    expect(confetti).toHaveBeenCalledOnce();
    triggerHoloSparkles();
    vi.runAllTimers();
    expect(confetti).toHaveBeenCalledTimes(4);
  });

  it('fires nothing under reduced motion', () => {
    reduce = true;
    triggerCardEffects('BRAINROT', true);
    triggerRarityConfetti('EPIC');
    vi.runAllTimers();
    expect(confetti).not.toHaveBeenCalled();
  });

  it('reads the setting on every burst, so turning it on mid-session stops the next one', () => {
    triggerRarityConfetti('EPIC');
    expect(confetti).toHaveBeenCalledOnce();
    triggerHoloSparkles();
    expect(confetti).toHaveBeenCalledTimes(2);
    reduce = true;
    vi.runAllTimers();
    triggerRarityConfetti('EPIC');
    expect(confetti).toHaveBeenCalledTimes(2);
  });
});
