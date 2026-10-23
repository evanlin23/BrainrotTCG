/**
 * The sparks a swipe throws off, drawn on one canvas (#266). A spark used to be a DOM node with its own
 * CSS animation: a swipe kept up to a few hundred of them alive, and on a slow phone styling and
 * layering them cost more than the rest of the swipe together. Here a spark is a record, and one
 * animation-frame loop draws every live one onto a single layer, so a swipe adds no DOM, no React
 * render and no style work, and the loop stops the moment nothing is left to draw.
 */

/** How long a spark lives. */
export const SPARK_LIFETIME_MS = 620;
/** The most sparks alive at once. Past it the oldest, nearly faded, go first. */
export const MAX_SPARKS = 120;
/** Sparks thrown by one emit. */
export const SPARKS_PER_BURST = 3;
/** Emits closer together than this add nothing. */
export const SPARK_THROTTLE_MS = 9;
/** A spark is this many times its size across at full strength: a hot core, fading to a glow. */
const GLOW_DIAMETER = 2.5;
const START_SCALE = 0.52;
const END_SCALE = 1.7;
/** A frame this soon after a paint repeats it: the emit that made the burst already drew it in this frame. */
const REPAINT_GAP_MS = 3;
/** The glow's colour in the sprite, if the stylesheet doesn't say (tokens.css --spark-glow). */
const FALLBACK_GLOW = 'rgba(255, 200, 100, 0.9)';
const SPRITE_PX = 64;

interface LiveSpark {
  born: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  size: number;
  sprite: CanvasImageSource;
}

/** What a field draws on: a canvas whose 2D context it owns. */
export type SparkCanvas = Pick<HTMLCanvasElement, 'width' | 'height' | 'getContext'>;

/** The outside world, replaceable so a test drives time and frames itself. */
export interface SparkEnvironment {
  now: () => number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  random: () => number;
  /** A sprite for one hue, drawn once and reused: the spark's radial glow. */
  makeSprite: (hue: number, glow: string) => CanvasImageSource;
}

export interface SparkField {
  /** Throw a burst from a point in the layer's own layout pixels. */
  emit: (x: number, y: number) => void;
  /** Size the layer and say where its top-left sits in the pack, all in layout pixels. */
  resize: (width: number, height: number, left?: number, top?: number) => void;
  /** Drop every spark and the pending frame, and wipe the layer. */
  clear: () => void;
  /** clear(), for good: the field draws and schedules nothing more. */
  dispose: () => void;
  /** Sparks alive now. */
  readonly live: number;
}

/** The same colour at alpha 0, from a canvas's normalised colour (`#rrggbb` or `rgb(a)(r, g, b[, a])`); null if it is neither. */
export function withoutAlpha(color: string): string | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (hex) return `rgba(${parseInt(hex[1], 16)}, ${parseInt(hex[2], 16)}, ${parseInt(hex[3], 16)}, 0)`;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(color.trim());
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, 0)` : null;
}

const browserEnvironment = (): SparkEnvironment => ({
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  random: Math.random,
  makeSprite: (hue, glow) => {
    const sprite = document.createElement('canvas');
    sprite.width = SPRITE_PX;
    sprite.height = SPRITE_PX;
    const context = sprite.getContext('2d');
    if (!context) return sprite;
    const half = SPRITE_PX / 2;
    // The same stops the CSS spark had: a hot core, through the spark's hue, to the warm glow and out.
    const gradient = context.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, `hsl(${hue} 100% 92%)`);
    gradient.addColorStop(0.42, `hsl(${hue} 100% 78%)`);
    gradient.addColorStop(0.62, `hsl(${hue} 100% 66% / 0.95)`);
    gradient.addColorStop(0.78, glow);
    // Canvas gradients interpolate unpremultiplied, so ending on `transparent` (black at alpha 0) would
    // fade the halo through grey; end on the glow's own colour at alpha 0 instead.
    context.fillStyle = glow;
    gradient.addColorStop(1, withoutAlpha(String(context.fillStyle)) ?? withoutAlpha(FALLBACK_GLOW)!);
    context.fillStyle = gradient;
    context.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
    return sprite;
  },
});

/** CSS `ease-out`, near enough: fast off the seam, slowing as the spark fades. */
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

export function createSparkField(canvas: SparkCanvas, options: { glow?: string; environment?: SparkEnvironment } = {}): SparkField {
  const env = options.environment ?? browserEnvironment();
  const glow = options.glow || FALLBACK_GLOW;
  const context = canvas.getContext('2d');
  const sprites = new Map<number, CanvasImageSource>();
  let sparks: LiveSpark[] = [];
  let frameId: number | null = null;
  let disposed = false;
  let width = 0;
  let height = 0;
  let left = 0;
  let top = 0;
  let lastEmitAt = -Infinity;
  let lastPaintAt = -Infinity;

  const spriteFor = (hue: number) => {
    let sprite = sprites.get(hue);
    if (!sprite) {
      sprite = env.makeSprite(hue, glow);
      sprites.set(hue, sprite);
    }
    return sprite;
  };

  const paint = (now: number) => {
    lastPaintAt = now;
    sparks = sparks.filter((spark) => now - spark.born < SPARK_LIFETIME_MS);
    if (!context) return;
    context.setTransform(1, 0, 0, 1, -left, -top);
    context.clearRect(left, top, width, height);
    for (const spark of sparks) {
      const progress = easeOut(Math.max(0, now - spark.born) / SPARK_LIFETIME_MS);
      const diameter = spark.size * GLOW_DIAMETER * (START_SCALE + (END_SCALE - START_SCALE) * progress);
      context.globalAlpha = 1 - progress;
      context.drawImage(spark.sprite, spark.x + spark.dx * progress - diameter / 2, spark.y + spark.dy * progress - diameter / 2, diameter, diameter);
    }
    context.globalAlpha = 1;
  };

  const cancelPendingFrame = () => {
    if (frameId !== null) env.cancelFrame(frameId);
    frameId = null;
  };

  const frame = () => {
    frameId = null;
    if (disposed) return;
    const now = env.now();
    if (now - lastPaintAt >= REPAINT_GAP_MS) paint(now);
    // The loop runs only while there is something to draw.
    if (sparks.length > 0) frameId = env.requestFrame(frame);
  };

  const wipe = () => {
    cancelPendingFrame();
    sparks = [];
    if (context) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  return {
    emit(x, y) {
      if (disposed) return;
      const now = env.now();
      if (now - lastEmitAt < SPARK_THROTTLE_MS) return;
      lastEmitAt = now;
      for (let burst = 0; burst < SPARKS_PER_BURST; burst += 1) {
        sparks.push({
          born: now,
          x: x + (env.random() * 16 - 8),
          y: y + (env.random() * 4 - 2),
          dx: env.random() * 56 - 28,
          dy: -(env.random() * 36 + 10),
          size: Math.round(env.random() * 8 + 9),
          sprite: spriteFor(Math.round(env.random() * 24 + 38)),
        });
      }
      if (sparks.length > MAX_SPARKS) sparks.splice(0, sparks.length - MAX_SPARKS);
      // Drawn now, inside the frame that draws the cut it sparks from, then once per frame until they fade.
      paint(now);
      if (frameId === null) frameId = env.requestFrame(frame);
    },
    resize(nextWidth, nextHeight, nextLeft = 0, nextTop = 0) {
      if (disposed) return;
      width = nextWidth;
      height = nextHeight;
      left = nextLeft;
      top = nextTop;
      // One canvas pixel per layout pixel: the sparks are soft glows, and a canvas costs the browser
      // its area every frame it changes.
      canvas.width = Math.max(1, Math.round(nextWidth));
      canvas.height = Math.max(1, Math.round(nextHeight));
      // Resizing wipes the layer; sparks still alive come back on the next frame.
      if (sparks.length > 0 && frameId === null) frameId = env.requestFrame(frame);
    },
    clear: wipe,
    dispose() {
      disposed = true;
      wipe();
    },
    get live() {
      return sparks.length;
    },
  };
}
