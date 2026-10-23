/**
 * Raster helpers for the pack wrapper's stickers: an exact distance transform for die-cut borders,
 * and the sticker itself (art under a white die-cut border, a thin dark edge and a soft shadow).
 * Plain arithmetic on raw pixels plus sharp, so a build gives the same bytes every time.
 */
import sharp from 'sharp';

/** Stands in for "no inside pixel on this line": far beyond any real squared distance. */
const FAR = 1e20;

/** Squared distance along one row or column (Felzenszwalb and Huttenlocher's lower envelope). */
const edt1d = (f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array) => {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
};

/** Each pixel's Euclidean distance to the nearest pixel where `inside` is set (0 inside). */
export const distanceToInside = (inside: Uint8Array, w: number, h: number): Float32Array => {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = inside[y * w + x] ? 0 : FAR;
    edt1d(f, h, out, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = out[y];
  }
  const dist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, out, v, z);
    for (let x = 0; x < w; x++) dist[y * w + x] = Math.sqrt(out[x]);
  }
  return dist;
};

export type Rgb = [number, number, number];
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** A layer for `dieCut`: `fill` wherever the distance to the shape is at most `grow` px. */
export interface Ring {
  grow: number;
  fill: Rgb;
}

/**
 * Flatten a shape's rings (largest first, so each sits on the one before), then `top` (RGBA, the
 * art or logo) over them, onto a transparent canvas `w` x `h`. `shape` is the coverage (0-255) the
 * rings grow from. Anti-aliased: a ring's edge is half a pixel either side of its distance.
 */
export const dieCut = (shape: Uint8Array, w: number, h: number, rings: Ring[], top?: Uint8Array) => {
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = shape[i] >= 128 ? 1 : 0;
  const dist = distanceToInside(inside, w, h);
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    const over = (c: Rgb | readonly number[], alpha: number) => {
      if (alpha <= 0) return;
      const na = alpha + a * (1 - alpha);
      r = (c[0] * alpha + r * a * (1 - alpha)) / na;
      g = (c[1] * alpha + g * a * (1 - alpha)) / na;
      b = (c[2] * alpha + b * a * (1 - alpha)) / na;
      a = na;
    };
    for (const ring of rings) over(ring.fill, inside[i] ? 1 : clamp01(ring.grow + 0.5 - dist[i]));
    if (top) over([top[i * 4], top[i * 4 + 1], top[i * 4 + 2]], top[i * 4 + 3] / 255);
    out[i * 4] = Math.round(r);
    out[i * 4 + 1] = Math.round(g);
    out[i * 4 + 2] = Math.round(b);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
};

/** Coverage (0-255) of a round or rounded-rect sticker filling a `w` x `h` box, anti-aliased. */
export const shapeCoverage = (kind: 'round' | 'rect', w: number, h: number): Uint8Array => {
  const out = new Uint8Array(w * h);
  const [cx, cy] = [w / 2, h / 2];
  const radius = kind === 'round' ? Math.min(w, h) / 2 : Math.min(w, h) * 0.16;
  const [hx, hy] = kind === 'round' ? [radius, radius] : [w / 2, h / 2];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Signed distance to a rounded box (a circle when the box is the radius).
      const qx = Math.abs(x + 0.5 - cx) - (hx - radius);
      const qy = Math.abs(y + 0.5 - cy) - (hy - radius);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      out[y * w + x] = Math.round(clamp01(0.5 - d) * 255);
    }
  }
  return out;
};

export const WHITE: Rgb = [255, 255, 255];

/**
 * Add a soft drop shadow under an RGBA image and turn it by `rot` degrees. Returns a PNG and its size.
 * `shadow` is the shadow's offset and blur in px.
 */
export const shadowAndTurn = async (rgba: Buffer, w: number, h: number, rot: number, shadow = { x: 5, y: 8, blur: 6, opacity: 0.5 }) => {
  const pad = Math.ceil(shadow.blur * 3 + Math.max(Math.abs(shadow.x), Math.abs(shadow.y)));
  const silhouette = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) silhouette[i * 4 + 3] = Math.round(rgba[i * 4 + 3] * shadow.opacity);
  const raw = { raw: { width: w, height: h, channels: 4 as const } };
  const blurred = await sharp(silhouette, raw)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(shadow.blur)
    .png()
    .toBuffer();
  const sticker = await sharp(rgba, raw).png().toBuffer();
  const flat = await sharp(blurred)
    .composite([{ input: sticker, left: pad - shadow.x, top: pad - shadow.y }])
    .png()
    .toBuffer();
  const turned = await sharp(flat).rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer({ resolveWithObject: true });
  return { png: turned.data, width: turned.info.width, height: turned.info.height };
};

/**
 * The part of an image placed at (`left`, `top`) that falls inside a `w` x `h` canvas, as sharp's
 * composite wants it (no part outside the canvas). Undefined when none of it does.
 */
export const clipToCanvas = async (png: Buffer, iw: number, ih: number, left: number, top: number, w: number, h: number) => {
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(w, left + iw);
  const y1 = Math.min(h, top + ih);
  if (x1 <= x0 || y1 <= y0) return undefined;
  const input =
    x0 === left && y0 === top && x1 - x0 === iw && y1 - y0 === ih
      ? png
      : await sharp(png).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  return { input, left: x0, top: y0 };
};
