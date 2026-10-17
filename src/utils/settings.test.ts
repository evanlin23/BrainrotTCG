import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, effectsLevel, musicLevel, readSettings } from './settings';

describe('settings', () => {
  it('starts new players with music off and effects enabled', () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(null)).toMatchObject({ musicVolume: 0, effectsVolume: 1 });
    expect(readSettings({ particlesEnabled: false, showDraftSets: true })).toEqual({ ...DEFAULT_SETTINGS, particlesEnabled: false, showDraftSets: true });
    // A new player's pages stay gated unless they chose to show every one (#222).
    expect(readSettings(null).showAllPages).toBeUndefined();
    expect(readSettings({ showAllPages: true }).showAllPages).toBe(true);
  });

  it('turns the old sound switch into the two sliders', () => {
    expect(readSettings({ soundEnabled: true, particlesEnabled: true })).toEqual({ ...DEFAULT_SETTINGS, musicVolume: 0.5 });
    const muted = readSettings({ soundEnabled: false, particlesEnabled: true });
    expect([muted.musicVolume, muted.effectsVolume]).toEqual([0, 0]);
    expect(muted).not.toHaveProperty('soundEnabled');
  });

  it('preserves saved slider choices, including music enabled or explicitly muted', () => {
    expect(readSettings({ musicVolume: 0.5, effectsVolume: 0.3 })).toMatchObject({ musicVolume: 0.5, effectsVolume: 0.3 });
    expect(readSettings({ musicVolume: 0, effectsVolume: 0.8, soundEnabled: true })).toMatchObject({ musicVolume: 0, effectsVolume: 0.8 });
  });

  it('enables good-pull pauses for older saves, preserves the toggle, and rejects malformed values', () => {
    expect(readSettings({ musicVolume: 0.2 }).pauseBigPulls).toBe(true);
    expect(readSettings({ pauseBigPulls: false }).pauseBigPulls).toBe(false);
    expect(readSettings({ pauseBigPulls: true }).pauseBigPulls).toBe(true);
    expect(readSettings({ pauseBigPulls: 'false' }).pauseBigPulls).toBe(true);
    expect(readSettings({ pauseBigPulls: null }).pauseBigPulls).toBe(true);
  });

  it('keeps sliders in range', () => {
    expect(readSettings({ musicVolume: 3, effectsVolume: -1 })).toMatchObject({ musicVolume: 1, effectsVolume: 0 });
    expect(readSettings({ musicVolume: 'loud', effectsVolume: Number.NaN })).toMatchObject({ musicVolume: 0, effectsVolume: 1 });
    expect(readSettings({ musicVolume: 0.2, soundEnabled: false }).musicVolume).toBe(0.2); // a set slider wins
  });

  it('keeps the volume curve and legacy music loudness', () => {
    expect(musicLevel(0.5)).toBeCloseTo(0.05);
    expect(musicLevel(DEFAULT_SETTINGS.musicVolume)).toBe(0);
    expect(effectsLevel(DEFAULT_SETTINGS.effectsVolume)).toBe(1);
    expect(musicLevel(0)).toBe(0);
    expect(effectsLevel(0)).toBe(0);
  });
});
