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
export const CARD_FLIP_SRC = cardFlipSrc;
export const FAIRY_DUST_SRC = fairyDustSrc;
export const WOOSH_SRC = wooshSrc;
