// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import { cardFinishThumbUrl } from '../../content/art';
import CardImage from './CardImage';

const { holdFinishedCardImage, release, renderedHold } = vi.hoisted(() => {
  const release = vi.fn();
  const renderedHold = (src: string, finish?: string | null): { image: Promise<string>; release: () => void } =>
    ({ image: Promise.resolve(`rendered:${finish}:${src}`), release });
  return { release, renderedHold, holdFinishedCardImage: vi.fn(renderedHold) };
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

  it('hands focus back to Retry when a retry fails again, but never takes focus the player moved', async () => {
    await act(async () => root.render(
      <div className="dialog" tabIndex={-1}>
        <button type="button" className="close">Close</button>
        <CardImage src={card.image} finish="GOLD" alt={card.name} retry />
      </div>,
    ));
    const img = container.querySelector('img')!;
    const close = container.querySelector<HTMLButtonElement>('.close')!;
    const retryButton = () => container.querySelector<HTMLButtonElement>('.card-image-retry');
    close.focus();
    await fire(img, 'error');
    // A failure on its own leaves focus where it was.
    expect(document.activeElement).toBe(close);

    retryButton()!.focus();
    await act(async () => retryButton()!.click());
    expect(document.activeElement).toBe(container.querySelector('.dialog'));
    await fire(img, 'error');
    expect(img.dataset.state).toBe('failed');
    expect(document.activeElement).toBe(retryButton());

    // The player tabs away while the next attempt loads: the new failure does not pull focus back.
    await act(async () => retryButton()!.click());
    close.focus();
    await fire(img, 'error');
    expect(retryButton()).not.toBeNull();
    expect(document.activeElement).toBe(close);
  });

  it('returns focus to Retry without a focusable container, when focus fell to the page', async () => {
    await act(async () => root.render(<CardImage src={card.image} alt={card.name} retry />));
    const img = container.querySelector('img')!;
    await fire(img, 'error');
    container.querySelector<HTMLButtonElement>('.card-image-retry')!.focus();
    await act(async () => container.querySelector<HTMLButtonElement>('.card-image-retry')!.click());
    await fire(img, 'error');
    expect(document.activeElement).toBe(container.querySelector('.card-image-retry'));
  });

  it('starts afresh when the same card switches between its thumbnail and full-size view', async () => {
    await act(async () => root.render(<CardImage src={card.image} finish="GOLD" alt="" />));
    const img = container.querySelector('img')!;
    await fire(img, 'error');
    expect(img.dataset.state).toBe('failed');

    // The ready-made thumbnail is a different download: an earlier full-size failure says nothing about it.
    await act(async () => root.render(<CardImage src={card.image} finish="GOLD" thumbnail alt="" />));
    expect(img.getAttribute('src')).toBe(cardFinishThumbUrl(card.image, 'GOLD'));
    expect(img.dataset.state).toBe('loading');
  });

  it('keeps a loaded image ready when the same card without a finish switches between thumbnail and full size (#484)', async () => {
    const plain = ALL_CARDS[0];
    await act(async () => root.render(<CardImage src={plain.image} thumbnail alt="" />));
    const img = container.querySelector('img')!;
    // jsdom loads no images: from here on the img reports the art it shows as fully loaded, as a browser would.
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    const naturalWidth = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(256);
    try {
      await fire(img, 'load');
      expect(img.dataset.state).toBe('ready');
      // Same src either way, so no new load event comes.
      await act(async () => root.render(<CardImage src={plain.image} alt="" />));
      expect(img.getAttribute('src')).toBe(plain.image);
      expect(img.dataset.state).toBe('ready');
      await act(async () => root.render(<CardImage src={plain.image} thumbnail alt="" />));
      expect(img.dataset.state).toBe('ready');

      // A new URL the img hasn't finished still waits for its load event.
      naturalWidth.mockReturnValue(0);
      await act(async () => root.render(<CardImage src={card.image} thumbnail alt="" />));
      expect(img.dataset.state).toBe('loading');
      await fire(img, 'load');
      expect(img.dataset.state).toBe('ready');
    } finally {
      complete.mockRestore();
      naturalWidth.mockRestore();
    }
  });

  it('marks a loading image scrolled out of view so its shimmer pauses, and stops watching once it settles or unmounts', async () => {
    const observed = new Set<Element>();
    let notify: IntersectionObserverCallback | undefined;
    const unobserve = vi.fn((element: Element) => observed.delete(element));
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback; }
      observe(element: Element) { observed.add(element); }
      unobserve = unobserve;
      disconnect() { observed.clear(); }
    });
    const scroll = (target: Element, isIntersecting: boolean) =>
      act(() => notify!([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
    // The module keeps one observer for every image: a fresh copy makes it this test's, whatever ran before.
    vi.resetModules();
    const { default: CardImage } = await import('./CardImage');

    await act(async () => root.render(<CardImage src={card.image} alt="" />));
    const img = container.querySelector('img')!;
    expect(img.dataset.state).toBe('loading');
    expect(observed.has(img)).toBe(true);
    scroll(img, false);
    expect(img.hasAttribute('data-offscreen')).toBe(true);
    scroll(img, true);
    expect(img.hasAttribute('data-offscreen')).toBe(false);

    scroll(img, false);
    await fire(img, 'load');
    expect(img.dataset.state).toBe('ready');
    expect(observed.has(img)).toBe(false);
    expect(img.hasAttribute('data-offscreen')).toBe(false);
    // An entry queued before it stopped watching changes nothing.
    scroll(img, false);
    expect(img.hasAttribute('data-offscreen')).toBe(false);

    // One still loading when it unmounts stops being watched too.
    await act(async () => root.render(<CardImage key="next" src={ALL_CARDS[0].image} alt="" />));
    const next = container.querySelector('img')!;
    expect(observed.has(next)).toBe(true);
    unobserve.mockClear();
    await act(async () => root.render(<></>));
    expect(unobserve).toHaveBeenCalledExactlyOnceWith(next);
    expect(observed.size).toBe(0);
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

describe('finish render holds', () => {
  let root: Root;
  let container: HTMLElement;
  const [first, second] = ALL_CARDS;

  /** Counts live holds per render the way finishImage's LRU does, and every release beyond one per hold. */
  const countHolds = () => {
    const holders = new Map<string, number>();
    const pending = new Map<string, (url: string) => void>();
    let extraReleases = 0;
    holdFinishedCardImage.mockImplementation((src: string, finish?: string | null) => {
      const key = `${finish}:${src}`;
      holders.set(key, (holders.get(key) ?? 0) + 1);
      let held = true;
      return {
        image: new Promise<string>((resolve) => pending.set(key, resolve)),
        release: () => {
          if (!held) extraReleases += 1;
          else holders.set(key, holders.get(key)! - 1);
          held = false;
        },
      };
    });
    return { holders, pending, extraReleases: () => extraReleases };
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    holdFinishedCardImage.mockClear();
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    holdFinishedCardImage.mockImplementation(renderedHold);
    vi.unstubAllGlobals();
  });

  it('holds one render through a StrictMode double mount and lets it go once on unmount', async () => {
    const holds = countHolds();
    await act(async () => root.render(<StrictMode><CardImage src={first.image} finish="GOLD" alt="" /></StrictMode>));
    expect(holds.holders.get(`GOLD:${first.image}`)).toBe(1);
    await act(async () => holds.pending.get(`GOLD:${first.image}`)!('blob:gold'));
    expect(container.querySelector('img')!.getAttribute('src')).toBe('blob:gold');

    await act(async () => root.render(<StrictMode><></></StrictMode>));
    expect(holds.holders.get(`GOLD:${first.image}`)).toBe(0);
    expect(holds.extraReleases()).toBe(0);
  });

  it('lets go of the old card when the card changes while its render is still loading', async () => {
    const holds = countHolds();
    await act(async () => root.render(<CardImage src={first.image} finish="GOLD" alt="" />));
    const img = container.querySelector('img')!;
    expect(img.dataset.state).toBe('rendering');

    await act(async () => root.render(<CardImage src={second.image} finish="GOLD" alt="" />));
    expect(holds.holders.get(`GOLD:${first.image}`)).toBe(0);
    expect(holds.holders.get(`GOLD:${second.image}`)).toBe(1);
    // The old render finishing late never lands on the new card.
    await act(async () => holds.pending.get(`GOLD:${first.image}`)!('blob:first'));
    expect(img.getAttribute('src')).toMatch(PLACEHOLDER);
    await act(async () => holds.pending.get(`GOLD:${second.image}`)!('blob:second'));
    expect(img.getAttribute('src')).toBe('blob:second');

    await act(async () => root.render(<></>));
    expect(holds.holders.get(`GOLD:${second.image}`)).toBe(0);
    expect(holds.extraReleases()).toBe(0);
  });

  it('stays quiet when a render it let go of is dropped, and still reports any other failure', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fail = new Map<string, (error: Error) => void>();
    holdFinishedCardImage.mockImplementation((src: string) => ({
      image: new Promise<string>((_, reject) => fail.set(src, reject)),
      release: () => {},
    }));
    const third = ALL_CARDS[2];
    try {
      await act(async () => root.render(<CardImage src={first.image} finish="GOLD" alt="" />));
      await act(async () => root.render(<CardImage src={second.image} finish="GOLD" alt="" />));
      const img = container.querySelector('img')!;
      // A render that already started and fails after its image moved on is still reported, but
      // never lands on the image now showing another card.
      await act(async () => fail.get(first.image)!(new Error('Could not load first')));
      expect(logged).toHaveBeenCalledExactlyOnceWith('Could not render card finish', new Error('Could not load first'));
      expect(img.dataset.state).toBe('rendering');

      await act(async () => root.render(<CardImage src={third.image} finish="GOLD" alt="" />));
      // finishImage drops a queued render nothing holds any more (#226), as an AbortError.
      const dropped = Object.assign(new Error('Finish render no longer needed'), { name: 'AbortError' });
      await act(async () => fail.get(second.image)!(dropped));
      expect(logged).toHaveBeenCalledTimes(1);

      await act(async () => fail.get(third.image)!(new Error('Could not load')));
      expect(logged).toHaveBeenLastCalledWith('Could not render card finish', new Error('Could not load'));
      // The plain art stands in for the finish.
      expect(img.getAttribute('src')).toBe(third.image);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('art this build will not request', () => {
  const EXTERNAL = ['https://tracker.example/pixel.gif?id=1', '//tracker.example/pixel.gif', 'data:image/svg+xml,<svg/>', 'javascript:alert(1)'];
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    holdFinishedCardImage.mockReset();
    holdFinishedCardImage.mockImplementation(renderedHold);
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each(EXTERNAL)('shows the blocked placeholder instead of %s', (src) => {
    for (const finish of [undefined, 'GOLD' as const]) {
      for (const thumbnail of [false, true]) {
        const html = renderToStaticMarkup(<CardImage src={src} finish={finish} thumbnail={thumbnail} retry alt="" />);
        expect(html).toContain('data-state="blocked"');
        expect(html).toMatch(/src="data:image\/gif;base64,/);
        expect(html).not.toContain('tracker.example');
        expect(html).not.toContain('javascript:');
        expect(html).not.toContain('svg');
        expect(html).not.toContain('<button');
      }
    }
  });

  it('never renders a finish for it, offers Retry, or lets an error or load change its state', async () => {
    const onError = vi.fn();
    await act(async () => root.render(<CardImage src={EXTERNAL[0]} finish="GOLD" retry alt="" onError={onError} />));
    const img = container.querySelector('img')!;
    expect(holdFinishedCardImage).not.toHaveBeenCalled();
    expect(img.dataset.state).toBe('blocked');
    expect(img.getAttribute('src')).toMatch(PLACEHOLDER);
    expect(container.querySelector('button')).toBeNull();

    await act(async () => { img.dispatchEvent(new Event('load')); img.dispatchEvent(new Event('error')); });
    expect(img.dataset.state).toBe('blocked');
    expect(img.getAttribute('src')).toMatch(PLACEHOLDER);
    expect(container.querySelector('button')).toBeNull();
    expect(holdFinishedCardImage).not.toHaveBeenCalled();
  });

  it('moves on and off the placeholder on the same img as the stored address changes', async () => {
    const card = ALL_CARDS[0];
    await act(async () => root.render(<CardImage src={card.image} alt="" />));
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(card.image);
    await act(async () => root.render(<CardImage src={EXTERNAL[0]} alt="" />));
    expect(container.querySelector('img')).toBe(img);
    expect(img.dataset.state).toBe('blocked');
    expect(img.getAttribute('src')).toMatch(PLACEHOLDER);
    await act(async () => root.render(<CardImage src="/archive/old-card.webp" alt="" />));
    expect(img.getAttribute('src')).toBe('/archive/old-card.webp');
    expect(img.dataset.state).toBe('loading');
  });

  it('still shows archived art on this site, with or without a finish', async () => {
    expect(renderToStaticMarkup(<CardImage src="/BrainrotTCG/assets/old-1a2b.webp" alt="" />)).toContain('src="/BrainrotTCG/assets/old-1a2b.webp"');
    await act(async () => root.render(<CardImage src="/old.webp" finish="GOLD" alt="" />));
    expect(holdFinishedCardImage).toHaveBeenCalledWith('/old.webp', 'GOLD');
  });
});
