/**
 * The QR codes drawn into share posters. A code goes in only after a decoder reads the exact link
 * back from the pixels the poster will draw, at the exported size and at the smaller sizes chat
 * apps shrink images to. A link too dense to read that way gets no code (the poster says so and the
 * link travels with the image), rather than a code that looks right and does not scan.
 */
import qrcode from 'qrcode-generator';
import { INK, PAPER } from '../styles/palette';

/** The square the code and its quiet zone must fit in, in poster pixels. */
export const QR_BOX = 260;
/** Quiet zone, in modules: the standard four. */
export const QR_QUIET = 4;
/** Fewest poster pixels per module; fewer and a shrunk image blurs neighbouring modules together. */
export const QR_MIN_CELL = 3;
/** Image scales the code must still decode at (1 is the exported poster). */
export const QR_SHRINKS = [1, 2 / 3] as const;
/** Paper around the code in the check, as the label stock the poster prints it on. */
const SURROUND = 24;

export interface QrPlan {
  /** Modules per side. */
  count: number;
  /** Whole poster pixels per module: the code is drawn on an integer grid, never fractional cells. */
  cell: number;
  /** Side of the code with its quiet zone, in poster pixels. */
  side: number;
  isDark: (row: number, col: number) => boolean;
}

interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The code as the poster draws it (a cell-pixel square per dark module on paper), plus paper around it. */
export const rasterQr = (plan: QrPlan): Pixels => {
  const size = plan.side + SURROUND * 2;
  const data = new Uint8ClampedArray(size * size * 4);
  const paper = rgb(PAPER);
  const ink = rgb(INK);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor((y - SURROUND) / plan.cell) - QR_QUIET;
      const col = Math.floor((x - SURROUND) / plan.cell) - QR_QUIET;
      const inside = y >= SURROUND && x >= SURROUND && y < SURROUND + plan.side && x < SURROUND + plan.side;
      const dark = inside && row >= 0 && col >= 0 && row < plan.count && col < plan.count && plan.isDark(row, col);
      const colour = dark ? ink : paper;
      const i = (y * size + x) * 4;
      data[i] = colour[0];
      data[i + 1] = colour[1];
      data[i + 2] = colour[2];
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size };
};

/** The image resampled to `scale` with a box filter, as a chat app's downscale would. */
export const shrinkPixels = (image: Pixels, scale: number): Pixels => {
  if (scale === 1) return image;
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = y / scale;
    const y1 = Math.min(image.height, (y + 1) / scale);
    for (let x = 0; x < width; x++) {
      const x0 = x / scale;
      const x1 = Math.min(image.width, (x + 1) / scale);
      const sum = [0, 0, 0];
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const w = (Math.min(sx + 1, x1) - Math.max(sx, x0)) * (Math.min(sy + 1, y1) - Math.max(sy, y0));
          const i = (sy * image.width + sx) * 4;
          sum[0] += w * image.data[i];
          sum[1] += w * image.data[i + 1];
          sum[2] += w * image.data[i + 2];
          weight += w;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = sum[0] / weight;
      data[o + 1] = sum[1] / weight;
      data[o + 2] = sum[2] / weight;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
};

/** Whether a decoder reads exactly `url` from the plan's pixels at every size in QR_SHRINKS. */
export const decodesAtEverySize = async (plan: QrPlan, url: string): Promise<boolean> => {
  let decode: typeof import('jsqr').default;
  try {
    // Off the startup path: only a poster with a link loads the decoder.
    decode = (await import('jsqr')).default;
  } catch {
    return false;
  }
  const exported = rasterQr(plan);
  return QR_SHRINKS.every((scale) => {
    const { data, width, height } = shrinkPixels(exported, scale);
    return decode(data, width, height, { inversionAttempts: 'dontInvert' })?.data === url;
  });
};

/**
 * A QR code for the link that a decoder round trip proved readable, with the most error correction
 * that fits QR_BOX at QR_MIN_CELL pixels a module; null if no code does (the link is too dense).
 */
export const planQr = async (url: string): Promise<QrPlan | null> => {
  for (const level of ['M', 'L'] as const) {
    let qr: ReturnType<typeof qrcode>;
    try {
      qr = qrcode(0, level);
      qr.addData(url);
      qr.make();
    } catch {
      // Longer than any QR code holds.
      continue;
    }
    const count = qr.getModuleCount();
    const cell = Math.floor(QR_BOX / (count + QR_QUIET * 2));
    if (cell < QR_MIN_CELL) continue;
    const plan: QrPlan = { count, cell, side: (count + QR_QUIET * 2) * cell, isDark: (r, c) => qr.isDark(r, c) };
    if (await decodesAtEverySize(plan, url)) return plan;
  }
  return null;
};
