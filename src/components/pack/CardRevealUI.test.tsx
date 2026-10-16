import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ALL_CARDS } from '../../data/cards';
import CardRevealUI from './CardRevealUI';
import type { CardWithMeta } from '../cards/Card';

const card: CardWithMeta = {
  ...ALL_CARDS[0],
  rarity: 'COMMON',
  uniqueId: 1,
  isRevealed: true,
  isHolo: false,
  finish: 'DIAMOND', // 10,000 points
};
const render = (revealLocked: boolean, currentCard = card) => renderToStaticMarkup(
  <CardRevealUI currentCard={currentCard} currentIndex={0} totalCards={5} hasMovedMouse
    onInteraction={() => {}} onSkip={() => {}} celebrating revealLocked={revealLocked} />,
);

describe('good-pull reveal', () => {
  it('keeps the celebration when the pause is off and enables Skip', () => {
    const html = render(false);
    expect(html).toContain('is-celebrating');
    expect(html).toContain('10,000 points');
    expect(html).toContain('--special-reveal-duration:3000ms');
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain('disabled=""');
  });

  it('disables Skip during the protected celebration', () => {
    const html = render(true);
    expect(html).toContain('10,000 points');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
  });

  it('does not show a stale celebration on an ordinary or face-down card', () => {
    expect(render(false, { ...card, finish: 'GOLD' })).not.toContain('special-reveal-celebration');
    expect(render(false, { ...card, isRevealed: false })).not.toContain('special-reveal-celebration');
  });
});

describe('the reveal\'s controls', () => {
  it('has no way out of its own: the X and the card count are in the pack\'s top bar', () => {
    const html = render(false);
    expect(html).not.toContain('Back to packs');
    expect(html).not.toContain('Close pack');
    expect(html).not.toContain('role="progressbar"');
  });

  it('puts Skip in its own bottom row, below the hint', () => {
    const html = render(false);
    expect(html).toMatch(/<p class="tip-text">[^<]*<\/p><div class="reveal-bottom"><button[^>]*class="reveal-skip"/);
  });
});
