import { describe, expect, it } from 'vitest';
import dingSrc from '../assets/effects/ding.mp3';
import rizzSrc from '../assets/effects/rizz-sound-effect.mp3';
import tacoBellSrc from '../assets/effects/taco-bell-bong-sfx.mp3';
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

  it('pins each sound\'s gain', () => {
    expect(soundGain(rizzSrc)).toBe(0.5);
    expect(soundGain(tacoBellSrc)).toBe(0.5);
    expect(soundGain(dingSrc)).toBe(0.65);
    expect(soundGain(WOOSH_SRC)).toBe(0.45);
    expect(soundGain(FAIRY_DUST_SRC)).toBe(0.5);
  });

  it('trims the Blondie voices and leaves the others at full', () => {
    const voices = import.meta.glob('../assets/voices/ElevenLabs_*.mp3', { eager: true }) as Record<string, { default: string }>;
    const entries = Object.entries(voices);
    expect(entries.some(([path]) => path.includes('Blondie'))).toBe(true);
    for (const [path, m] of entries) expect(soundGain(m.default)).toBe(path.includes('Blondie') ? 0.75 : 1);
    expect(soundGain(BRAINROT_VOICES[0])).toBe(1);
  });
});

describe('soundVolume stays a valid element volume', () => {
  it('clamps above 1 and below 0', () => {
    expect(soundVolume('/nope.mp3', 2)).toBe(1);
    expect(soundVolume(VINE_BOOM_SRC, 10)).toBe(1);
    expect(soundVolume('/nope.mp3', -1)).toBe(0);
  });

  it('maps NaN and a missing level to 0', () => {
    expect(soundVolume(VINE_BOOM_SRC, NaN)).toBe(0);
    expect(soundVolume(VINE_BOOM_SRC, undefined as unknown as number)).toBe(0);
    expect(soundVolume(null, Infinity)).toBe(0);
  });
});
