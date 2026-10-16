// Audio asset imports
import whatBrainrotOriginal from '../assets/voices/what-brainrot.mp3';
import cardFlipSrc from '../assets/audio/Card-flip-sound-effect.mp3';
import fairyDustSrc from '../assets/audio/fairy-dust-sound-effect.mp3';
import wooshSrc from '../assets/audio/woosh.mp3';
import dingSrc from '../assets/effects/ding.mp3';
import rizzSrc from '../assets/effects/rizz-sound-effect.mp3';
import tacoBellSrc from '../assets/effects/taco-bell-bong-sfx.mp3';
import vineBoomSrc from '../assets/effects/vine-boom.mp3';

// Auto-scan for ElevenLabs voice files
const elevenLabsVoices = import.meta.glob('../assets/voices/ElevenLabs_*.mp3', { eager: true }) as Record<string, { default: string }>;

export const BRAINROT_VOICES = [
  whatBrainrotOriginal,
  ...Object.values(elevenLabsVoices).map(m => m.default)
];

export const EFFECT_SOUNDS = [dingSrc, rizzSrc, tacoBellSrc, vineBoomSrc];
export const VINE_BOOM_SRC = vineBoomSrc;
export const CARD_FLIP_SRC = cardFlipSrc;
export const FAIRY_DUST_SRC = fairyDustSrc;
export const WOOSH_SRC = wooshSrc;

/** The random effect starts this long after the card flip, so their peaks don't add up. */
export const EFFECT_DELAY_MS = 120;

// Per-sound gain (0 to 1, multiplied onto the effects level) that evens out the files' loudness.
const voiceGain = (name: string) => (name.includes('Blondie') ? 0.75 : 1);
const SOUND_GAINS = new Map<string, number>([
  [vineBoomSrc, 0.35],
  [rizzSrc, 0.5],
  [tacoBellSrc, 0.5],
  [dingSrc, 0.65],
  [wooshSrc, 0.45],
  [fairyDustSrc, 0.5],
  [cardFlipSrc, 0.8],
  [whatBrainrotOriginal, 1],
  ...Object.entries(elevenLabsVoices).map(([path, m]): [string, number] => [m.default, voiceGain(path)]),
]);

/** The gain for a sound by its imported src; 1 for one it doesn't know. */
export const soundGain = (src: string | null | undefined): number => (src ? SOUND_GAINS.get(src) ?? 1 : 1);

/** The element volume for a sound at an effects level, kept in [0, 1] (HTMLMediaElement.volume throws outside it or on NaN). */
export const soundVolume = (src: string | null | undefined, level: number): number => {
  const volume = level * soundGain(src);
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
};
