import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSparkField, MAX_SPARKS, SPARK_LIFETIME_MS, SPARK_THROTTLE_MS, SPARKS_PER_BURST, withoutAlpha, type SparkEnvironment } from './sparkField';

interface Draw { x: number; y: number; size: number; alpha: number }

/** A 2D context that only records what is drawn and where the layer's origin sits. */
const fakeCanvas = () => {
  const draws: Draw[] = [];
  const context = {
    globalAlpha: 1,
    transform: [1, 0, 0, 1, 0, 0],
    clears: 0,
    setTransform(...matrix: number[]) { this.transform = matrix; },
    clearRect() { this.clears += 1; },
    drawImage(_sprite: unknown, x: number, y: number, size: number) { draws.push({ x, y, size, alpha: this.globalAlpha }); },
  };
  const canvas = { width: 300, height: 150, getContext: vi.fn(() => context) };
  return { canvas: canvas as unknown as HTMLCanvasElement, context, draws, getContext: canvas.getContext };
};

/** Time and frames the test steps by hand: nothing runs on its own. */
const fakeEnvironment = () => {
  let time = 1000;
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const environment: SparkEnvironment = {
    now: () => time,
    requestFrame: (callback) => { frames.set(nextId, callback); return nextId++; },
    cancelFrame: (id) => { frames.delete(id); },
    random: () => 0.5,
    makeSprite: vi.fn(() => ({}) as CanvasImageSource),
  };
  const advance = (ms: number) => { time += ms; };
  /** Run the one pending frame, if any, as the browser would at this time. */
  const runFrame = () => {
    const [id, callback] = [...frames.entries()][0] ?? [];
    if (id === undefined || !callback) return false;
    frames.delete(id);
    callback();
    return true;
  };
  return { environment, advance, runFrame, pending: () => frames.size };
};

let env: ReturnType<typeof fakeEnvironment>;
beforeEach(() => { env = fakeEnvironment(); });

describe('createSparkField (#266)', () => {
  it('draws a burst at once, where it was thrown, in the pack\'s layout pixels', () => {
    const { canvas, context, draws } = fakeCanvas();
    const field = createSparkField(canvas, { environment: env.environment });
    // A band 144px tall whose top sits 20px down the pack and whose left edge is the pack's.
    field.resize(320, 144, 0, 20);
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(144);

    field.emit(192, 109);
    expect(field.live).toBe(SPARKS_PER_BURST);
    expect(draws).toHaveLength(SPARKS_PER_BURST);
    // With the random source at 0.5 there is no jitter: the spark's centre is the point itself, and the
    // origin shift puts it at (192, 109 - 20) on the band's own pixels.
    for (const draw of draws) {
      expect(draw.x + draw.size / 2).toBeCloseTo(192);
      expect(draw.y + draw.size / 2).toBeCloseTo(109);
      expect(draw.alpha).toBe(1);
    }
    expect(context.transform).toEqual([1, 0, 0, 1, -0, -20]);
  });

  it('keeps one frame pending however many bursts it draws, and stops the loop once all have faded', () => {
    const { canvas } = fakeCanvas();
    const field = createSparkField(canvas, { environment: env.environment });
    field.resize(320, 144);
    field.emit(10, 10);
    env.advance(SPARK_THROTTLE_MS);
    field.emit(20, 10);
    expect(env.pending()).toBe(1);

    // The loop keeps asking for frames while a spark is alive...
    env.advance(SPARK_LIFETIME_MS / 2);
    expect(env.runFrame()).toBe(true);
    expect(env.pending()).toBe(1);
    // ...and does not once the last one has gone.
    env.advance(SPARK_LIFETIME_MS);
    expect(env.runFrame()).toBe(true);
    expect(field.live).toBe(0);
    expect(env.pending()).toBe(0);
  });

  it('never keeps more than the cap alive through a long held drag', () => {
    const { canvas } = fakeCanvas();
    const field = createSparkField(canvas, { environment: env.environment });
    field.resize(320, 144);
    let peak = 0;
    // Five seconds of a finger moving every 16ms: far more bursts than the cap holds.
    for (let elapsed = 0; elapsed < 5000; elapsed += 16) {
      field.emit(100 + (elapsed % 120), 50);
      peak = Math.max(peak, field.live);
      env.advance(16);
      env.runFrame();
    }
    expect(peak).toBeLessThanOrEqual(MAX_SPARKS);
    expect(env.pending()).toBeLessThanOrEqual(1);
  });

  it('drops emits closer together than the throttle', () => {
    const { canvas } = fakeCanvas();
    const field = createSparkField(canvas, { environment: env.environment });
    field.resize(320, 144);
    field.emit(10, 10);
    env.advance(SPARK_THROTTLE_MS - 1);
    field.emit(11, 10);
    expect(field.live).toBe(SPARKS_PER_BURST);
    env.advance(1);
    field.emit(12, 10);
    expect(field.live).toBe(2 * SPARKS_PER_BURST);
  });

  it('fades each spark out over its lifetime', () => {
    const { canvas, draws } = fakeCanvas();
    const field = createSparkField(canvas, { environment: env.environment });
    field.resize(320, 144);
    field.emit(10, 10);
    draws.length = 0;
    env.advance(SPARK_LIFETIME_MS / 2);
    env.runFrame();
    expect(draws).toHaveLength(SPARKS_PER_BURST);
    for (const draw of draws) expect(draw.alpha).toBeGreaterThan(0);
    expect(Math.max(...draws.map((draw) => draw.alpha))).toBeLessThan(0.5);
  });

  it('builds one sprite per hue, not one per spark', () => {
    const { canvas } = fakeCanvas();
    const field = createSparkField(canvas, { environment: env.environment });
    field.resize(320, 144);
    for (let burst = 0; burst < 10; burst += 1) {
      field.emit(10, 10);
      env.advance(SPARK_THROTTLE_MS);
    }
    // random() is constant here, so every spark has the same hue.
    expect(env.environment.makeSprite).toHaveBeenCalledTimes(1);
  });

  it('wipes the layer and cancels its frame on clear, and on dispose for good', () => {
    const { canvas, context, draws } = fakeCanvas();
    const field = createSparkField(canvas, { environment: env.environment });
    field.resize(320, 144);
    field.emit(10, 10);
    expect(env.pending()).toBe(1);
    field.clear();
    expect(field.live).toBe(0);
    expect(env.pending()).toBe(0);
    expect(context.transform).toEqual([1, 0, 0, 1, 0, 0]);

    env.advance(SPARK_THROTTLE_MS);
    field.emit(10, 10);
    expect(env.pending()).toBe(1);
    field.dispose();
    expect(env.pending()).toBe(0);

    const drawn = draws.length;
    env.advance(SPARK_THROTTLE_MS);
    field.emit(10, 10);
    field.resize(100, 100);
    expect(field.live).toBe(0);
    expect(env.pending()).toBe(0);
    expect(draws).toHaveLength(drawn);
  });

  it('redraws the sparks still alive after a resize wiped the layer', () => {
    const { canvas } = fakeCanvas();
    const field = createSparkField(canvas, { environment: env.environment });
    field.resize(320, 144);
    field.emit(10, 10);
    env.runFrame();
    expect(env.pending()).toBe(1);
    field.resize(300, 144);
    expect(env.pending()).toBe(1);
  });

  it('survives a canvas with no 2D context, and still lets the sparks expire', () => {
    const { canvas, getContext } = fakeCanvas();
    getContext.mockReturnValue(null as never);
    const field = createSparkField(canvas, { environment: env.environment });
    field.resize(320, 144);
    expect(() => field.emit(10, 10)).not.toThrow();
    env.advance(SPARK_LIFETIME_MS + 1);
    env.runFrame();
    expect(field.live).toBe(0);
    expect(env.pending()).toBe(0);
  });
});

describe('withoutAlpha', () => {
  it.each([
    ['#ffc864', 'rgba(255, 200, 100, 0)'],
    ['rgba(255, 200, 100, 0.9)', 'rgba(255, 200, 100, 0)'],
    ['rgb(255,200,100)', 'rgba(255, 200, 100, 0)'],
  ])('keeps the colour of %s and drops only its alpha, so the halo fades warm, not through grey', (color, expected) => {
    expect(withoutAlpha(color)).toBe(expected);
  });

  it('says so for a colour it cannot read, rather than guessing black', () => {
    expect(withoutAlpha('transparent')).toBeNull();
    expect(withoutAlpha('color(display-p3 1 0.8 0.4)')).toBeNull();
  });
});
