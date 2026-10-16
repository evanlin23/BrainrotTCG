import { describe, expect, it } from 'vitest';
import { BRAINROT_VOICES, CARD_FLIP_SRC, EFFECT_SOUNDS, FAIRY_DUST_SRC, VINE_BOOM_SRC, WOOSH_SRC, soundGain, soundVolume } from './audio';

describe('per-sound gains', () => {
  it.each([...EFFECT_SOUNDS, ...BRAINROT_VOICES, CARD_FLIP_SRC, WOOSH_SRC, FAIRY_DUST_SRC])('%s has a gain in (0, 1]', (src) => {
    const gain = soundGain(src);
    expect(gain).toBeGreaterThan(0);
    expect(gain).toBeLessThanOrEqual(1);
  });

  it('trims the loud effects and leaves an unknown src alone', () => {
    expect(soundGain(VINE_BOOM_SRC)).toBe(0.35);
    expect(soundGain(CARD_FLIP_SRC)).toBe(0.8);
    expect(soundGain('/nope.mp3')).toBe(1);
    expect(soundGain(null)).toBe(1);
    expect(soundVolume(VINE_BOOM_SRC, 0.5)).toBeCloseTo(0.175);
  });
});
