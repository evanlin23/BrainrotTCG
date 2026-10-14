import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ALL_CARDS } from '../../data/cards';
import { cardFinishThumbUrl } from '../../content/art';
import CardImage from './CardImage';

const FINISHES = ['SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'] as const;

describe('collection finish thumbnails', () => {
  it.each(FINISHES)('shows a ready-made %s finish on the first render', (finish) => {
    const card = ALL_CARDS.find((card) => card.id === 'verity')!;
    const thumb = cardFinishThumbUrl(card.image, finish);
    expect(thumb).toBeTruthy();
    const html = renderToStaticMarkup(<CardImage src={card.image} finish={finish} thumbnail loading="lazy" alt={card.name} />);
    expect(html).toContain(`src="${thumb}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('visibility:hidden');
    expect(html).not.toContain('thumbnail=');
  });

  it('has all four finished thumbnails for every registered card', () => {
    for (const card of ALL_CARDS) {
      const thumbs = FINISHES.map((finish) => cardFinishThumbUrl(card.image, finish));
      expect(thumbs.every(Boolean), card.key).toBe(true);
      expect(new Set(thumbs).size, card.key).toBe(4);
    }
  });

  it('keeps full-size finished views on the full-resolution path', () => {
    const card = ALL_CARDS.find((card) => card.id === 'verity')!;
    const html = renderToStaticMarkup(<CardImage src={card.image} finish="GOLD" loading="lazy" alt={card.name} />);
    expect(html).toContain(`src="${card.image}"`);
    expect(html).toContain('visibility:hidden');
    expect(html).not.toContain('/finish-thumbs/');
  });

  it('keeps plain cards visible and falls back to full rendering for unknown images', () => {
    const card = ALL_CARDS[0];
    const plain = renderToStaticMarkup(<CardImage src={card.image} thumbnail loading="lazy" alt="" />);
    expect(plain).toContain(`src="${card.image}"`);
    expect(plain).not.toContain('visibility:hidden');
    expect(cardFinishThumbUrl('/custom-card.webp', 'GOLD')).toBeUndefined();
    const custom = renderToStaticMarkup(<CardImage src="/custom-card.webp" finish="GOLD" thumbnail loading="lazy" alt="" />);
    expect(custom).toContain('src="/custom-card.webp"');
    expect(custom).toContain('visibility:hidden');
  });
});

describe('nondraggable default', () => {
  it('defaults draggable to false on standard, thumbnail, and finish image paths', () => {
    const card = ALL_CARDS[0];

    const standardHtml = renderToStaticMarkup(<CardImage src={card.image} alt={card.name} />);
    expect(standardHtml).toContain('draggable="false"');

    const thumbnailHtml = renderToStaticMarkup(<CardImage src={card.image} finish="GOLD" thumbnail alt={card.name} />);
    expect(thumbnailHtml).toContain('draggable="false"');

    const finishHtml = renderToStaticMarkup(<CardImage src={card.image} finish="GOLD" alt={card.name} />);
    expect(finishHtml).toContain('draggable="false"');
  });

  it('allows callers to explicitly override draggable prop', () => {
    const card = ALL_CARDS[0];

    const overrideHtml = renderToStaticMarkup(<CardImage src={card.image} draggable alt={card.name} />);
    expect(overrideHtml).toContain('draggable="true"');
  });
});
