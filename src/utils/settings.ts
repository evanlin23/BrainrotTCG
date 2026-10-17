import type { Settings } from '../types';

/**
 * Settings, and the sound effects slider (cards, the pack, voices), from 0 (off) to 1. The slider
 * moves along a squared curve, which sounds more even than a straight line. New players start with
 * effects at full; a saved choice remains. Music was removed: older saves and tabs may still carry a
 * `musicVolume`, which is dropped on read.
 */
export const DEFAULT_SETTINGS: Settings = {
  effectsVolume: 1,
  particlesEnabled: true,
  pauseBigPulls: true,
};

const slider = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

type StoredSettings = Partial<Settings> & { soundEnabled?: boolean; musicVolume?: unknown };

/** Older saves' sound switch mutes effects when off. An explicit slider wins. */
export const readSettings = (stored: unknown): Settings => {
  const { soundEnabled, musicVolume: _music, ...rest } = (stored && typeof stored === 'object' ? stored : {}) as StoredSettings;
  const muted = soundEnabled === false;
  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    effectsVolume: slider(rest.effectsVolume, muted ? 0 : DEFAULT_SETTINGS.effectsVolume),
    pauseBigPulls: typeof rest.pauseBigPulls === 'boolean' ? rest.pauseBigPulls : DEFAULT_SETTINGS.pauseBigPulls,
  };
};

/** A sound effect's audio volume for a slider position. */
export const effectsLevel = (value: number): number => value ** 2;
