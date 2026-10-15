import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class ControlledImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  naturalWidth = 1;
  naturalHeight = 1;

  constructor() {
    images.push(this);
  }

  load() { this.onload?.(); }
  fail() { this.onerror?.(); }
}

let images: ControlledImage[];
let createObjectURL: ReturnType<typeof vi.spyOn>;
let createElement: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  images = [];
  vi.stubGlobal('Image', ControlledImage);
  const context = {
    drawImage: vi.fn(),
    getImageData: () => ({ width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) }),
    putImageData: vi.fn(),
  };
  createElement = vi.fn(() => ({
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (callback: BlobCallback) => callback(new Blob()),
  }));
  vi.stubGlobal('document', { createElement });
  createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:finished-card');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const expectReleased = (image: ControlledImage) => {
  expect(image.onload).toBeNull();
  expect(image.onerror).toBeNull();
};

describe('finish image request deadlines', () => {
  it('returns unmodified cards without starting image requests or timers', async () => {
    const { finishedCardImage } = await import('./finishImage');
    await expect(finishedCardImage('/card.webp')).resolves.toBe('/card.webp');
    await expect(finishedCardImage('/card.webp', null)).resolves.toBe('/card.webp');
    expect(images).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stalled card, ignores its late load, and allows a fresh retry', async () => {
    const { finishedCardImage } = await import('./finishImage');
    const first = finishedCardImage('/card.webp', 'GOLD');
    expect(finishedCardImage('/card.webp', 'GOLD')).toBe(first);
    const failure = first.catch((error: unknown) => error);
    const [card, mask] = images;
    const lateLoad = card.onload!;
    mask.load();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(card.onload).not.toBeNull();
    expectReleased(mask);
    await vi.advanceTimersByTimeAsync(1);
    expect(await failure).toEqual(new Error('Image load timed out: /card.webp'));
    expectReleased(card);
    expect(vi.getTimerCount()).toBe(0);

    const retry = finishedCardImage('/card.webp', 'GOLD');
    expect(retry).not.toBe(first);
    expect(images).toHaveLength(3); // The successful frame mask is retained.
    lateLoad();
    await Promise.resolve();
    expect(createObjectURL).not.toHaveBeenCalled();
    images[2].load();
    await expect(retry).resolves.toBe('blob:finished-card');
    expect(finishedCardImage('/card.webp', 'GOLD')).toBe(retry);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stalled mask without accepting its late load and retries both inputs', async () => {
    const { finishedCardImage } = await import('./finishImage');
    const first = finishedCardImage('/card.webp', 'SILVER');
    const failure = first.catch((error: unknown) => error);
    const [card, mask] = images;
    const lateLoad = mask.onload!;
    card.load();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(await failure).toEqual(new Error(`Image load timed out: ${mask.src}`));
    expectReleased(card);
    expectReleased(mask);
    expect(vi.getTimerCount()).toBe(0);
    lateLoad();
    await Promise.resolve();
    expect(createElement).not.toHaveBeenCalled();

    const retry = finishedCardImage('/card.webp', 'SILVER');
    expect(retry).not.toBe(first);
    expect(images).toHaveLength(4);
    images[2].load();
    images[3].load();
    await expect(retry).resolves.toBe('blob:finished-card');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears successful load deadlines and ignores late errors without discarding the cached render', async () => {
    const { finishedCardImage } = await import('./finishImage');
    const result = finishedCardImage('/card.webp', 'DIAMOND');
    const [card, mask] = images;
    const lateCardError = card.onerror!;
    const lateMaskError = mask.onerror!;
    await vi.advanceTimersByTimeAsync(14_999);
    card.load();
    mask.load();
    await expect(result).resolves.toBe('blob:finished-card');
    expectReleased(card);
    expectReleased(mask);
    expect(vi.getTimerCount()).toBe(0);

    lateCardError();
    lateMaskError();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(finishedCardImage('/card.webp', 'DIAMOND')).toBe(result);
    expect(images).toHaveLength(2);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('clears a failed load deadline and keeps immediate errors retryable', async () => {
    const { finishedCardImage } = await import('./finishImage');
    const first = finishedCardImage('/card.webp', 'PLATINUM');
    const failure = first.catch((error: unknown) => error);
    const [card, mask] = images;
    const lateLoad = card.onload!;
    mask.load();
    card.fail();
    expect(await failure).toEqual(new Error('Could not load /card.webp'));
    expectReleased(card);
    expectReleased(mask);
    expect(vi.getTimerCount()).toBe(0);
    lateLoad();

    const retry = finishedCardImage('/card.webp', 'PLATINUM');
    expect(retry).not.toBe(first);
    images[2].load();
    await expect(retry).resolves.toBe('blob:finished-card');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
