import confetti from 'canvas-confetti';
import type { RarityKey } from '../data/cards';

interface ConfettiConfig {
  particleCount: number;
  spread: number;
  colors: string[];
}

const RARITY_CONFETTI: Partial<Record<RarityKey, ConfettiConfig>> = {
  BRAINROT: {
    particleCount: 250,
    spread: 100,
    colors: ['#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#0000ff', '#9400d3'],
  },
  LEGENDARY: {
    particleCount: 150,
    spread: 70,
    colors: ['#ff8000', '#ffd700'],
  },
  EPIC: {
    particleCount: 150,
    spread: 70,
    colors: ['#a335ee', '#bc13fe'],
  },
};

/**
 * Trigger confetti effect based on card rarity
 */
export const triggerRarityConfetti = (rarity: RarityKey): void => {
  const config = RARITY_CONFETTI[rarity];
  if (!config) return;

  confetti({
    particleCount: config.particleCount,
    spread: config.spread,
    origin: { y: 0.6 },
    colors: config.colors,
  });
};

/**
 * Trigger sparkle effect for holo cards
 */
export const triggerHoloSparkles = (): void => {
  // First burst
  confetti({
    particleCount: 60,
    spread: 80,
    origin: { y: 0.55 },
    colors: ['#ffffff', '#fffacd', '#f0f8ff', '#e6e6fa', '#ffd700'],
    shapes: ['star'],
    scalar: 1.2,
    gravity: 0.8,
    drift: 0,
    ticks: 150,
  });

  // Second burst slightly delayed
  setTimeout(() => {
    confetti({
      particleCount: 40,
      spread: 60,
      origin: { y: 0.5, x: 0.4 },
      colors: ['#ffffff', '#fffacd', '#87ceeb', '#dda0dd'],
      shapes: ['star'],
      scalar: 0.9,
      gravity: 0.6,
      ticks: 120,
    });
    confetti({
      particleCount: 40,
      spread: 60,
      origin: { y: 0.5, x: 0.6 },
      colors: ['#ffffff', '#fffacd', '#87ceeb', '#dda0dd'],
      shapes: ['star'],
      scalar: 0.9,
      gravity: 0.6,
      ticks: 120,
    });
  }, 150);
};

/**
 * Trigger appropriate confetti effects for a card
 */
export const triggerCardEffects = (rarity: RarityKey, isHolo: boolean): void => {
  triggerRarityConfetti(rarity);

  if (isHolo) {
    triggerHoloSparkles();
  }
};
