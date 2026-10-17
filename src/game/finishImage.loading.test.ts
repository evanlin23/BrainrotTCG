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
let encode: (callback: BlobCallback) => void;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  images = [];
  encode = (callback) => callback(new Blob());
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
    toBlob: (callback: BlobCallback) => encode(callback),
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

/** These deadline tests only read the result, so each request takes a hold it never gives back. */
const importFinishedCardImage = async () => {
  const { holdFinishedCardImage } = await import('./finishImage');
  return (src: string, finish?: Parameters<typeof holdFinishedCardImage>[1]) => holdFinishedCardImage(src, finish).image;
};

const expectReleased = (image: ControlledImage) => {
  expect(image.onload).toBeNull();
  expect(image.onerror).toBeNull();
};

describe('finish image request deadlines', () => {
  it('returns unmodified cards without starting image requests or timers', async () => {
    const finishedCardImage = await importFinishedCardImage();
    await expect(finishedCardImage('/card.webp')).resolves.toBe('/card.webp');
    await expect(finishedCardImage('/card.webp', null)).resolves.toBe('/card.webp');
    expect(images).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stalled card, ignores its late load, and allows a fresh retry', async () => {
    const finishedCardImage = await importFinishedCardImage();
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
    const finishedCardImage = await importFinishedCardImage();
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
    const finishedCardImage = await importFinishedCardImage();
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
    const finishedCardImage = await importFinishedCardImage();
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

describe('finish image encoding deadlines', () => {
  it('rejects a stalled encoding, ignores its late callback, and preserves a fresh retry', async () => {
    const callbacks: BlobCallback[] = [];
    encode = (callback) => { callbacks.push(callback); };
    const finishedCardImage = await importFinishedCardImage();
    const first = finishedCardImage('/card.webp', 'GOLD');
    let failure: unknown;
    void first.catch((error: unknown) => { failure = error; });
    images[0].load();
    images[1].load();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(failure).toBeUndefined();
    expect(callbacks).toHaveLength(1);
    expect(createObjectURL).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(failure).toEqual(new Error('Finish encoding timed out: /card.webp'));
    expect(vi.getTimerCount()).toBe(0);
    const retry = finishedCardImage('/card.webp', 'GOLD');
    expect(retry).not.toBe(first);
    images[2].load();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks).toHaveLength(2);

    callbacks[0](new Blob());
    await vi.advanceTimersByTimeAsync(0);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(finishedCardImage('/card.webp', 'GOLD')).toBe(retry);
    callbacks[1](new Blob());
    await expect(retry).resolves.toBe('blob:finished-card');
    expect(finishedCardImage('/card.webp', 'GOLD')).toBe(retry);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the encoding deadline on a null result and allows retry', async () => {
    encode = (callback) => callback(null);
    const finishedCardImage = await importFinishedCardImage();
    const first = finishedCardImage('/card.webp', 'SILVER');
    const failure = first.catch((error: unknown) => error);
    images[0].load();
    images[1].load();
    expect(await failure).toEqual(new Error('Finish render failed'));
    expect(vi.getTimerCount()).toBe(0);
    encode = (callback) => callback(new Blob());
    const retry = finishedCardImage('/card.webp', 'SILVER');
    expect(retry).not.toBe(first);
    images[2].load();
    await expect(retry).resolves.toBe('blob:finished-card');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the encoding deadline on a synchronous exception and allows retry', async () => {
    const encoderError = new Error('Encoder rejected the canvas');
    encode = () => { throw encoderError; };
    const finishedCardImage = await importFinishedCardImage();
    const first = finishedCardImage('/card.webp', 'DIAMOND');
    const failure = first.catch((error: unknown) => error);
    images[0].load();
    images[1].load();
    expect(await failure).toBe(encoderError);
    expect(vi.getTimerCount()).toBe(0);
    encode = (callback) => callback(new Blob());
    const retry = finishedCardImage('/card.webp', 'DIAMOND');
    expect(retry).not.toBe(first);
    images[2].load();
    await expect(retry).resolves.toBe('blob:finished-card');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('finished image cache', () => {
  let revoke: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    let made = 0;
    createObjectURL.mockImplementation(() => `blob:render-${made++}`);
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  const setup = async () => {
    const { holdFinishedCardImage, MAX_CACHED_FINISHES } = await import('./finishImage');
    /** Starts card `i`'s render; `loaded` lets its image (and the frame mask, the first time) arrive. */
    const hold = (i: number) => holdFinishedCardImage(`/card-${i}.webp`, 'GOLD');
    const loaded = async (held: ReturnType<typeof hold>) => {
      for (const image of images.splice(0)) image.load();
      return held.image;
    };
    /** Renders cards `from` to `to - 1`, as views that show each one and then go away. */
    const shownAndGone = async (from: number, to: number) => {
      const urls: string[] = [];
      for (let i = from; i < to; i++) {
        const held = hold(i);
        urls.push(await loaded(held));
        held.release();
      }
      return urls;
    };
    return { hold, loaded, shownAndGone, max: MAX_CACHED_FINISHES };
  };

  it('keeps a small bounded cache and revokes the least recent render once nothing holds it', async () => {
    const { hold, loaded, shownAndGone, max } = await setup();
    expect(max).toBe(16);
    const urls = await shownAndGone(0, max);
    expect(revoke).not.toHaveBeenCalled();

    const [newest] = await shownAndGone(max, max + 1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(urls[0]);

    // The rest are reused without another render; the evicted one renders again from scratch.
    const kept = hold(1);
    expect(images).toHaveLength(0);
    await expect(kept.image).resolves.toBe(urls[1]);
    kept.release();
    const again = hold(0);
    expect(images).toHaveLength(1);
    expect(await loaded(again)).not.toBe(urls[0]);
    again.release();
    expect(revoke).toHaveBeenLastCalledWith(urls[2]);
    expect(revoke).not.toHaveBeenCalledWith(newest);
  });

  it('counts a reused render as recent', async () => {
    const { hold, shownAndGone, max } = await setup();
    const urls = await shownAndGone(0, max);
    hold(0).release();
    await shownAndGone(max, max + 1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(urls[1]);
  });

  it('never revokes a render that is still held, and revokes it on its last release', async () => {
    const { hold, loaded, max } = await setup();
    const held: ReturnType<typeof hold>[] = [];
    for (let i = 0; i <= max; i++) {
      held.push(hold(i));
      await loaded(held[i]);
    }
    const second = hold(0);
    expect(revoke).not.toHaveBeenCalled();

    held[0].release();
    held[0].release(); // Releasing twice counts once.
    expect(revoke).not.toHaveBeenCalled();
    second.release();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(await held[0].image);

    // Back at the bound, so a later release keeps its render for reuse.
    held[5].release();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('revokes a render that was evicted before it finished', async () => {
    const { hold, shownAndGone, max } = await setup();
    const pending = hold(0);
    const [card] = images.splice(0, 1);
    pending.release();
    await shownAndGone(1, max + 1);
    expect(revoke).not.toHaveBeenCalled();

    card.load();
    const url = await pending.image;
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(url);
  });
});

describe('finish render concurrency', () => {
  const setup = async () => {
    const { holdFinishedCardImage, MAX_CONCURRENT_RENDERS } = await import('./finishImage');
    const hold = (i: number) => holdFinishedCardImage(`/card-${i}.webp`, 'GOLD');
    /** What each request ended as, so a rejection is read rather than left unhandled. */
    const outcome = (held: ReturnType<typeof hold>) => held.image.then(() => 'shown', (error: Error) => error.message);
    /** Card art requests in the order they started (the frame mask is left out). */
    const started = () => images.map((image) => image.src).filter((src) => src.startsWith('/card-'));
    const art = (i: number) => images.find((image) => image.src === `/card-${i}.webp`)!;
    return { hold, outcome, started, art, max: MAX_CONCURRENT_RENDERS };
  };

  it('runs at most two renders at once, starts queued ones in order, and frees a slot on failure', async () => {
    const { hold, outcome, started, art, max } = await setup();
    expect(max).toBe(2);
    const outcomes = [0, 1, 2, 3].map((i) => outcome(hold(i)));
    expect(started()).toEqual(['/card-0.webp', '/card-1.webp']);
    const mask = images[1];

    art(0).fail();
    expect(await outcomes[0]).toBe('Could not load /card-0.webp');
    await vi.advanceTimersByTimeAsync(0);
    expect(started()).toEqual(['/card-0.webp', '/card-1.webp', '/card-2.webp']);

    mask.load();
    art(1).load();
    expect(await outcomes[1]).toBe('shown');
    await vi.advanceTimersByTimeAsync(0);
    expect(started()).toEqual(['/card-0.webp', '/card-1.webp', '/card-2.webp', '/card-3.webp']);

    art(2).load();
    art(3).load();
    expect(await Promise.all(outcomes.slice(2))).toEqual(['shown', 'shown']);
    // No slot was lost along the way: the next two start at once.
    hold(4);
    hold(5);
    expect(started().slice(4)).toEqual(['/card-4.webp', '/card-5.webp']);
    expect(vi.getTimerCount()).toBe(2);
  });

  it('starts a queued render\'s load deadline only when its turn comes', async () => {
    const { hold, outcome, started, art } = await setup();
    const outcomes = [0, 1, 2].map((i) => outcome(hold(i)));
    const mask = images[1];
    await vi.advanceTimersByTimeAsync(10_000);
    mask.load();
    art(0).load();
    expect(await outcomes[0]).toBe('shown');
    await vi.advanceTimersByTimeAsync(0);
    expect(started()).toEqual(['/card-0.webp', '/card-1.webp', '/card-2.webp']);

    // Card 1 has waited since the start; card 2 only since card 0 finished, 10s in.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcomes[1]).toBe('Image load timed out: /card-1.webp');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(art(2).onload).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcomes[2]).toBe('Image load timed out: /card-2.webp');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops a queued render nothing holds by its turn, and renders it afresh when asked again', async () => {
    const { hold, outcome, started, art } = await setup();
    const [first, second, third, fourth, fifth] = [0, 1, 2, 3, 4].map(hold);
    const outcomes = [first, second, third, fourth, fifth].map(outcome);
    third.release();
    // Let go and taken again before its turn (a StrictMode remount): still wanted.
    fourth.release();
    const fourthAgain = hold(3);
    expect(fourthAgain.image).toBe(fourth.image);

    images[1].load(); // The frame mask.
    art(0).load();
    expect(await outcomes[0]).toBe('shown');
    expect(await outcomes[2]).toBe('Finish render no longer needed');
    await vi.advanceTimersByTimeAsync(0);
    // Card 2 never asked for its art; its slot went straight to card 3.
    expect(started()).toEqual(['/card-0.webp', '/card-1.webp', '/card-3.webp']);

    const again = hold(2);
    expect(again.image).not.toBe(third.image);
    const againOutcome = outcome(again);
    art(1).load();
    expect(await outcomes[1]).toBe('shown');
    await vi.advanceTimersByTimeAsync(0);
    expect(started()).toEqual(['/card-0.webp', '/card-1.webp', '/card-3.webp', '/card-4.webp']);
    art(3).load();
    art(4).load();
    await vi.advanceTimersByTimeAsync(0);
    art(2).load();
    expect(await Promise.all([outcomes[3], outcomes[4], againOutcome])).toEqual(['shown', 'shown', 'shown']);
  });
});
