// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGO_MARK_PATH } from '../styles/logoMark';
import { BRAND, PAPER } from '../styles/palette';
import {
  POSTER_IMAGE_TIMEOUT_MS,
  drawLogo,
  loadPosterImageElement,
  renderCardPoster,
  renderPoster,
  type CardPosterInput,
  type PosterInput,
} from './bragImage';

const TEXT_WIDTH = 700;

/** Records what drawLogo draws: each fill and fillText with the colour and translation at the time. */
const fakeContext = () => {
  const drawn: { kind: 'mark' | 'text'; colour: string; x: number; y: number; d?: string }[] = [];
  let at = { x: 0, y: 0 };
  const ctx = {
    font: '',
    textAlign: 'center',
    fillStyle: '',
    measureText: () => ({ width: TEXT_WIDTH }),
    save: () => undefined,
    restore: () => (at = { x: 0, y: 0 }),
    translate: (x: number, y: number) => (at = { x, y }),
    scale: () => undefined,
    fill: (path: { d: string }) => drawn.push({ kind: 'mark', colour: ctx.fillStyle, ...at, d: path.d }),
    fillText: (text: string, x: number, y: number) => {
      expect(text).toBe('BRAINROT TCG');
      drawn.push({ kind: 'text', colour: ctx.fillStyle, x, y });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
};

describe('drawLogo', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('draws the mark beside the wordmark, both with the misprint offset, centred together', () => {
    vi.stubGlobal('Path2D', class { constructor(readonly d: string) {} });
    const { ctx, drawn } = fakeContext();
    drawLogo(ctx, 160);

    expect(drawn.map(({ kind, colour }) => [kind, colour])).toEqual([
      ['mark', BRAND],
      ['text', BRAND],
      ['mark', PAPER],
      ['text', PAPER],
    ]);
    const [, , mark, text] = drawn;
    expect(mark.d).toBe(LOGO_MARK_PATH);
    // The yellow copies sit 8px down and right of the white ones.
    expect([drawn[0].x - mark.x, drawn[0].y - mark.y, drawn[1].x - text.x, drawn[1].y - text.y]).toEqual([8, 8, 8, 8]);
    // Mark, then the wordmark after it, with equal margins either side of the pair.
    expect(text.x).toBeGreaterThan(mark.x);
    expect(text.y).toBe(160);
    expect(mark.x).toBeCloseTo(1080 - (text.x + TEXT_WIDTH));
  });

  it('draws the wordmark alone, centred, where there is no Path2D', () => {
    vi.stubGlobal('Path2D', undefined);
    const { ctx, drawn } = fakeContext();
    drawLogo(ctx, 160);

    expect(drawn.map(({ kind, colour, x, y }) => [kind, colour, x, y])).toEqual([
      ['text', BRAND, 198, 168],
      ['text', PAPER, 190, 160],
    ]);
  });
});

describe('poster image loading deadline and recovery', () => {
  class ControlledImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = '';
    naturalWidth = 687;
    naturalHeight = 1024;

    constructor() {
      controlledImages.push(this);
    }

    load() {
      this.onload?.();
    }

    fail() {
      this.onerror?.();
    }
  }

  let controlledImages: ControlledImage[];

  beforeEach(() => {
    controlledImages = [];
    vi.useFakeTimers();
    vi.stubGlobal('Image', ControlledImage);

    const mockCtx = {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 100 })),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      clip: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      arcTo: vi.fn(),
      moveTo: vi.fn(),
      roundRect: vi.fn(),
      font: '',
      textAlign: 'left',
      fillStyle: '#fff',
      textBaseline: 'alphabetic',
    };

    HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('times out a held image request, clears handlers, and ignores late load', async () => {
    const promise = loadPosterImageElement('https://example.invalid/held.webp', 1000);
    const failure = promise.catch((err: unknown) => err);
    expect(controlledImages).toHaveLength(1);
    const img = controlledImages[0];
    const lateLoad = img.onload;

    await vi.advanceTimersByTimeAsync(999);
    expect(img.onload).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(await failure).toEqual(new Error('Poster image load timed out: https://example.invalid/held.webp'));

    // Image handlers and src are cleaned up
    expect(img.onload).toBeNull();
    expect(img.onerror).toBeNull();
    expect(img.src).toBe('');

    // Late load event does not throw or trigger anything
    expect(() => lateLoad?.()).not.toThrow();
  });

  it('rejects immediately on image load error and cleans up handlers', async () => {
    const promise = loadPosterImageElement('https://example.invalid/missing.webp', 1000);
    expect(controlledImages).toHaveLength(1);
    const img = controlledImages[0];

    img.fail();
    await expect(promise).rejects.toThrow('Could not load https://example.invalid/missing.webp');
    expect(img.onload).toBeNull();
    expect(img.onerror).toBeNull();
  });

  it('resolves immediately when image loads within the deadline', async () => {
    const promise = loadPosterImageElement('https://example.invalid/healthy.webp', 1000);
    expect(controlledImages).toHaveLength(1);
    const img = controlledImages[0];

    img.load();
    const loaded = await promise;
    expect(loaded).toBe(img);
    expect(img.onload).toBeNull();
    expect(img.onerror).toBeNull();
  });

  it('renders card poster through the production pipeline: held request -> timeout -> retry -> success', async () => {
    const cardInput: CardPosterInput = {
      card: {
        image: '/BrainrotTCG/assets/bukangi.webp',
        name: 'Bukangi',
        isHolo: false,
        rarityName: 'Common',
        raritySymbol: '⬜',
        rarityColor: '#999',
        number: '001',
      },
      setName: 'Right Now',
      setCode: 'RN',
      playerName: 'Player',
      fingerprint: 'abcd1234efgh5678',
      url: 'https://example.invalid/#/pull/test',
    };

    // First attempt: image request is held
    const attempt1 = renderCardPoster(cardInput);
    const failure1 = attempt1.catch((err: unknown) => err);
    await vi.waitFor(() => expect(controlledImages).toHaveLength(1));
    const heldImg = controlledImages[0];

    // Exceed timeout deadline
    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS);
    expect(await failure1).toEqual(new Error('Poster image load timed out: /BrainrotTCG/assets/bukangi.webp'));
    expect(heldImg.onload).toBeNull();

    // Second attempt (retry): image is now released and loads successfully
    const attempt2 = renderCardPoster(cardInput);
    await vi.waitFor(() => expect(controlledImages).toHaveLength(2));
    const retryImg = controlledImages[1];
    retryImg.load();

    const poster = await attempt2;
    expect(poster).toBeInstanceOf(Blob);
    expect(poster.type).toBe('image/png');
  });

  it('renders pack poster: fails if any card stalls, and succeeds when all cards load', async () => {
    const packInput: PosterInput = {
      cards: [
        { image: 'card-1.webp', name: 'Card 1', isHolo: false },
        { image: 'card-2.webp', name: 'Card 2', isHolo: false },
        { image: 'card-3.webp', name: 'Card 3', isHolo: false },
        { image: 'card-4.webp', name: 'Card 4', isHolo: false },
        { image: 'card-5.webp', name: 'Card 5', isHolo: false },
      ],
      score: { score: 1000, hand: { name: 'Full House', multiplier: 10 }, points: 100 },
      setName: 'Genesis',
      playerName: 'Player',
      fingerprint: '1234567812345678',
      url: 'https://example.invalid/#/pull/pack',
    };

    // First attempt: 4 cards load, but 5th card stalls
    const attempt1 = renderPoster(packInput);
    const failure1 = attempt1.catch((err: unknown) => err);
    await vi.waitFor(() => expect(controlledImages).toHaveLength(5));
    controlledImages[0].load();
    controlledImages[1].load();
    controlledImages[2].load();
    controlledImages[3].load();
    // 5th remains held

    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS);
    expect(await failure1).toEqual(new Error('Poster image load timed out: card-5.webp'));

    // Second attempt: all 5 cards load successfully
    const attempt2 = renderPoster(packInput);
    await vi.waitFor(() => expect(controlledImages).toHaveLength(10));
    for (let i = 5; i < 10; i++) {
      controlledImages[i].load();
    }

    const poster = await attempt2;
    expect(poster).toBeInstanceOf(Blob);
  });
});
