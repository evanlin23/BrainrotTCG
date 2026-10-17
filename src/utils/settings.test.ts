import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, effectsLevel, readSettings } from './settings';

describe('settings', () => {
  it('starts new players with effects enabled', () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(null)).toMatchObject({ effectsVolume: 1 });
    expect(readSettings({ particlesEnabled: false, showDraftSets: true })).toEqual({ ...DEFAULT_SETTINGS, particlesEnabled: false, showDraftSets: true });
    // A new player's pages stay gated unless they chose to show every one (#222).
    expect(readSettings(null).showAllPages).toBeUndefined();
    expect(readSettings({ showAllPages: true }).showAllPages).toBe(true);
  });

  it('turns the old sound switch into the effects slider', () => {
    expect(readSettings({ soundEnabled: true, particlesEnabled: true })).toEqual(DEFAULT_SETTINGS);
    const muted = readSettings({ soundEnabled: false, particlesEnabled: true });
    expect(muted.effectsVolume).toBe(0);
    expect(muted).not.toHaveProperty('soundEnabled');
  });

  it('preserves the saved effects choice, enabled or explicitly muted', () => {
    expect(readSettings({ effectsVolume: 0.3 })).toMatchObject({ effectsVolume: 0.3 });
    expect(readSettings({ effectsVolume: 0.8, soundEnabled: true })).toMatchObject({ effectsVolume: 0.8 });
    expect(readSettings({ effectsVolume: 0.2, soundEnabled: false }).effectsVolume).toBe(0.2); // a set slider wins
  });

  it('drops the removed music slider from older settings and keeps everything else', () => {
    const stored = {
      musicVolume: 0.5, soundEnabled: true, effectsVolume: 0.4, particlesEnabled: false, pauseBigPulls: false,
      cardBack: 'midnight', packFoil: 'gold', showDraftSets: true, showAllPages: true,
    };
    const { musicVolume: _music, soundEnabled: _sound, ...kept } = stored;
    expect(readSettings(stored)).toEqual(kept);
    // Any value an older build stored, valid or not, is dropped rather than carried forward.
    for (const musicVolume of [0, 1, 3, 'loud', null]) expect(readSettings({ musicVolume })).toEqual(DEFAULT_SETTINGS);
  });

  it('enables good-pull pauses for older saves, preserves the toggle, and rejects malformed values', () => {
    expect(readSettings({ effectsVolume: 0.2 }).pauseBigPulls).toBe(true);
    expect(readSettings({ pauseBigPulls: false }).pauseBigPulls).toBe(false);
    expect(readSettings({ pauseBigPulls: true }).pauseBigPulls).toBe(true);
    expect(readSettings({ pauseBigPulls: 'false' }).pauseBigPulls).toBe(true);
    expect(readSettings({ pauseBigPulls: null }).pauseBigPulls).toBe(true);
  });

  it('keeps the slider in range', () => {
    expect(readSettings({ effectsVolume: -1 })).toMatchObject({ effectsVolume: 0 });
    expect(readSettings({ effectsVolume: 3 })).toMatchObject({ effectsVolume: 1 });
    expect(readSettings({ effectsVolume: Number.NaN })).toMatchObject({ effectsVolume: 1 });
  });

  it('keeps the volume curve', () => {
    expect(effectsLevel(DEFAULT_SETTINGS.effectsVolume)).toBe(1);
    expect(effectsLevel(0.5)).toBeCloseTo(0.25);
    expect(effectsLevel(0)).toBe(0);
  });
});
