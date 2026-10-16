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

describe('closing a reveal', () => {
  const closeButton = (revealLocked: boolean) => {
    const html = renderToStaticMarkup(
      <CardRevealUI currentCard={card} currentIndex={0} totalCards={5} hasMovedMouse
        onInteraction={() => {}} onSkip={() => {}} onLeave={() => {}} celebrating={false} revealLocked={revealLocked} />,
    );
    return html.match(/<button[^>]*aria-label="Close pack"[^>]*>/)?.[0];
  };

  it('is an icon button named Close pack, disabled with Skip during the protected celebration', () => {
    expect(closeButton(false)).toContain('class="icon-btn reveal-close"');
    expect(closeButton(false)).not.toContain('disabled');
    expect(closeButton(true)).toContain('disabled=""');
    expect(render(false)).not.toContain('Close pack');
  });
});
