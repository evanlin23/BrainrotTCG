// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import { cardFinishThumbUrl } from '../../content/art';
import CardImage from './CardImage';

const { holdFinishedCardImage, release } = vi.hoisted(() => {
  const release = vi.fn();
  return {
    release,
    holdFinishedCardImage: vi.fn((src: string, finish?: string | null) => ({ image: Promise.resolve(`rendered:${finish}:${src}`), release })),
  };
});
// jsdom has no canvas; the full-size renderer is stubbed to a recognisable URL.
vi.mock('../../game/finishImage', () => ({ holdFinishedCardImage }));

/** The 1px placeholder shown while a finish renders or after a failure. */
const PLACEHOLDER = /^data:image\/gif;base64,/;

const FINISHES = ['SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'] as const;

describe('collection finish thumbnails', () => {
  it.each(FINISHES)('shows a ready-made %s finish on the first render', (finish) => {
    const card = ALL_CARDS.find((card) => card.id === 'verity')!;
    const thumb = cardFinishThumbUrl(card.image, finish);
    expect(thumb).toBeTruthy();
    const html = renderToStaticMarkup(<CardImage src={card.image} finish={finish} thumbnail loading="lazy" alt={card.name} />);
    expect(html).toContain(`src="${thumb}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('data-state="loading"');
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
    // The plain art is never shown (or fetched) in place of the finish while it renders.
    expect(html).toContain('src="data:image/gif;base64,');
    expect(html).not.toContain(`src="${card.image}"`);
    expect(html).toContain('data-state="rendering"');
    expect(html).not.toContain('/finish-thumbs/');
  });

  it('keeps plain cards visible and falls back to full rendering for unknown images', () => {
    const card = ALL_CARDS[0];
    const plain = renderToStaticMarkup(<CardImage src={card.image} thumbnail loading="lazy" alt="" />);
    expect(plain).toContain(`src="${card.image}"`);
    expect(plain).toContain('data-state="loading"');
    expect(cardFinishThumbUrl('/custom-card.webp', 'GOLD')).toBeUndefined();
    const custom = renderToStaticMarkup(<CardImage src="/custom-card.webp" finish="GOLD" thumbnail loading="lazy" alt="" />);
    expect(custom).not.toContain('src="/custom-card.webp"');
    expect(custom).toContain('data-state="rendering"');
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

describe('reserved box', () => {
  it('marks every card image for the card-shaped box (tests/card-image-styles.test.ts)', () => {
    const html = renderToStaticMarkup(<CardImage src={ALL_CARDS[0].image} className="card-full-image" alt="" />);
    expect(html).toContain('class="card-image card-full-image"');
    expect(renderToStaticMarkup(<CardImage src={ALL_CARDS[0].image} alt="" />)).toContain('class="card-image"');
  });
});

describe('thumbnail load failure', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    holdFinishedCardImage.mockClear();
    release.mockClear();
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
    expect(holdFinishedCardImage).not.toHaveBeenCalled();

    await act(async () => { img.dispatchEvent(new Event('error')); });
    await act(async () => {});

    expect(onError).toHaveBeenCalledTimes(1);
    expect(holdFinishedCardImage).toHaveBeenCalledWith(card.image, 'GOLD');
    expect(container.querySelector('img')).toBe(img);
    expect(img.getAttribute('src')).toBe(`rendered:GOLD:${card.image}`);
    expect(img.dataset.state).toBe('loading');

    // A later error on the rendered image is reported and shown as failed, not retried on its own.
    await act(async () => { img.dispatchEvent(new Event('error')); });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(holdFinishedCardImage).toHaveBeenCalledTimes(1);
    expect(img.getAttribute('src')).toMatch(PLACEHOLDER);
    expect(img.dataset.state).toBe('failed');
    // Without `retry` (a tile inside a button), no control is added.
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('failure and retry', () => {
  let root: Root;
  let container: HTMLElement;
  const card = ALL_CARDS.find((card) => card.id === 'verity')!;
  const fire = (img: HTMLImageElement, type: 'load' | 'error') => act(async () => { img.dispatchEvent(new Event(type)); });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    holdFinishedCardImage.mockClear();
    release.mockClear();
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('goes from loading to failed, retries from a keyboard-reachable control, and loads', async () => {
    await act(async () => root.render(
      <div className="dialog" tabIndex={-1}>
        <CardImage src={card.image} finish="GOLD" alt={card.name} retry />
      </div>,
    ));
    const img = container.querySelector('img')!;
    const rendered = `rendered:GOLD:${card.image}`;
    expect(img.getAttribute('src')).toBe(rendered);
    expect(img.dataset.state).toBe('loading');
    expect(container.querySelector('button')).toBeNull();

    await fire(img, 'error');
    expect(img.dataset.state).toBe('failed');
    expect(img.getAttribute('src')).toMatch(PLACEHOLDER);
    const retry = container.querySelector('button')!;
    expect(retry.getAttribute('aria-label')).toBe(`Retry loading ${card.name}`);
    expect(retry.type).toBe('button');
    expect(retry.tabIndex).toBe(0);
    retry.focus();
    expect(document.activeElement).toBe(retry);
    expect(release).not.toHaveBeenCalled();

    await act(async () => retry.click());
    // The retry takes a fresh hold on the render and lets the old one go after the swap.
    expect(holdFinishedCardImage).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button')).toBeNull();
    // Focus stays in the surrounding dialog instead of falling to the page.
    expect(document.activeElement).toBe(container.querySelector('.dialog'));
    expect(container.querySelector('img')).toBe(img);
    expect(img.getAttribute('src')).toBe(rendered);
    expect(img.dataset.state).toBe('loading');

    await fire(img, 'load');
    expect(img.dataset.state).toBe('ready');
  });

  it('recovers failed images without a control when any retry runs or the device comes back online', async () => {
    await act(async () => root.render(
      <>
        <CardImage src={card.image} alt="" />
        <CardImage src={ALL_CARDS[0].image} alt="" />
      </>,
    ));
    const [failing, fine] = [...container.querySelectorAll('img')];
    await fire(fine, 'load');
    await fire(failing, 'error');
    expect(failing.dataset.state).toBe('failed');

    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(failing.getAttribute('src')).toBe(card.image);
    expect(failing.dataset.state).toBe('loading');
    // An image that never failed is left alone.
    expect(fine.dataset.state).toBe('ready');

    await fire(failing, 'load');
    expect(failing.dataset.state).toBe('ready');
  });

  it('lets go of its render when it unmounts', async () => {
    await act(async () => root.render(<CardImage src={card.image} finish="GOLD" alt="" />));
    expect(holdFinishedCardImage).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    await act(async () => root.render(<></>));
    expect(release).toHaveBeenCalledTimes(1);
  });
});
