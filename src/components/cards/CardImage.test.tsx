// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import { cardFinishThumbUrl } from '../../content/art';
import CardImage from './CardImage';

const { finishedCardImage } = vi.hoisted(() => ({
  finishedCardImage: vi.fn(async (src: string, finish?: string | null) => `rendered:${finish}:${src}`),
}));
// jsdom has no canvas; the full-size renderer is stubbed to a recognisable URL.
vi.mock('../../game/finishImage', () => ({ finishedCardImage }));

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

describe('thumbnail load failure', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    finishedCardImage.mockClear();
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('falls back to the full-size finish renderer on the same img and still calls onError', async () => {
    const card = ALL_CARDS.find((card) => card.id === 'verity')!;
    const thumb = cardFinishThumbUrl(card.image, 'GOLD')!;
    const onError = vi.fn();
    act(() => root.render(<CardImage src={card.image} finish="GOLD" thumbnail alt={card.name} onError={onError} />));
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(thumb);
    expect(finishedCardImage).not.toHaveBeenCalled();

    await act(async () => { img.dispatchEvent(new Event('error')); });
    await act(async () => {});

    expect(onError).toHaveBeenCalledTimes(1);
    expect(finishedCardImage).toHaveBeenCalledWith(card.image, 'GOLD');
    expect(container.querySelector('img')).toBe(img);
    expect(img.getAttribute('src')).toBe(`rendered:GOLD:${card.image}`);
    expect(img.style.visibility).toBe('');

    // A later error on the rendered image is only reported, not retried.
    await act(async () => { img.dispatchEvent(new Event('error')); });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(finishedCardImage).toHaveBeenCalledTimes(1);
    expect(img.getAttribute('src')).toBe(`rendered:GOLD:${card.image}`);
  });
});
