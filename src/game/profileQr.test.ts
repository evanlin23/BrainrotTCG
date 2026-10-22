import jsQR from 'jsqr';
import { afterEach, expect, it, vi } from 'vitest';
import { INK } from '../styles/palette';
import { renderProfilePoster, type ProfilePosterInput } from './bragImage';
import { DECODER_LOAD_MS, decoderLoader, planQr, QR_BOX, QR_QUIET, QR_SHRINKS, shrinkPixels } from './qrCode';

// The decoder can be told to misread, to prove a code it cannot read back is never drawn.
const decoder = vi.hoisted(() => ({ misread: false }));
vi.mock('jsqr', async (original) => {
  const actual = await original<typeof import('jsqr')>();
  return { default: ((...args: Parameters<typeof actual.default>) => (decoder.misread ? null : actual.default(...args))) as typeof actual.default };
});

const W = 1080;
const H = 1920;
/** The label the poster prints its code on (x, y, w, h), which also leaves paper around the code. */
const LABEL = { x: 70, y: 1570, w: 940, h: 290 };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const through = async (bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** A real PNG (8-bit RGBA, unfiltered rows, deflated) of the canvas pixels. */
const png = async (rgba: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
  const raw = new Uint8Array((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) raw.set(rgba.subarray(y * W * 4, (y + 1) * W * 4), y * (W * 4 + 1) + 1);
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, W);
  new DataView(header.buffer).setUint32(4, H);
  header.set([8, 6, 0, 0, 0], 8);
  const idat = await through(raw, new CompressionStream('deflate'));
  return join(SIGNATURE, chunk('IHDR', header), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))) as Uint8Array<ArrayBuffer>;
};

/** Reads back the pixels of an 8-bit RGBA, unfiltered PNG (what png() above writes). */
const unpng = async (bytes: Uint8Array<ArrayBuffer>) => {
  expect([...bytes.subarray(0, 8)]).toEqual([...SIGNATURE]);
  const view = new DataView(bytes.buffer);
  const idat: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    if (new TextDecoder().decode(bytes.subarray(at + 4, at + 8)) === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = await through(join(...idat) as Uint8Array<ArrayBuffer>, new DecompressionStream('deflate'));
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) data.set(raw.subarray(y * (W * 4 + 1) + 1, (y + 1) * (W * 4 + 1)), y * W * 4);
  return data;
};

/** A canvas that paints fillRect and fill (rectangles and rounded rectangles) in hex colours, and records text. */
const stubCanvas = () => {
  const pixels = new Uint8Array(W * H * 4);
  const text: string[] = [];
  let fillStyle = '';
  let path: [number, number, number, number] | null = null;
  const paint = (x: number, y: number, w: number, h: number) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fillStyle);
    if (!m) return;
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(H, Math.round(y + h)); yy++) {
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(W, Math.round(x + w)); xx++) {
        pixels.set([parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255], (yy * W + xx) * 4);
      }
    }
  };
  const gradient = { addColorStop: () => undefined };
  const ctx = new Proxy(
    {
      measureText: (s: string) => ({ width: s.length * 10 }),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      beginPath: () => (path = null),
      roundRect: (x: number, y: number, w: number, h: number) => (path = [x, y, w, h]),
      fill: (shape?: unknown) => {
        if (!shape && path) paint(...path);
      },
      fillRect: paint,
      fillText: (s: string) => text.push(s),
    } as Record<string, unknown>,
    {
      get: (target, key: string) => (key === 'fillStyle' ? fillStyle : (target[key] ?? (() => undefined))),
      set: (target, key: string, value) => {
        if (key === 'fillStyle') fillStyle = typeof value === 'string' ? value : '';
        else target[key] = value;
        return true;
      },
    },
  );
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toBlob: (done: (b: Blob) => void) => void png(pixels).then((bytes) => done(new Blob([bytes], { type: 'image/png' }))),
  };
  vi.stubGlobal('document', { createElement: () => canvas });
  return { text };
};

const input = (url: string): ProfilePosterInput => ({
  playerName: 'QR Reopen QA',
  fingerprint: 'ABCD-EFGH',
  level: 3,
  title: 'Rookie',
  xp: 10,
  levelXp: 0,
  nextLevelXp: 100,
  packs: 64,
  unique: 4,
  totalCards: 100,
  holos: 1,
  bestScore: 12,
  points: 5,
  milestoneFloor: 0,
  sets: [],
  url,
});

/** Renders the profile poster, reads the exported PNG back, and decodes the label at each shrink size. */
const exportAndDecode = async (url: string) => {
  const { text } = stubCanvas();
  const blob = await renderProfilePoster(input(url));
  expect(blob.type).toBe('image/png');
  const pixels = await unpng(new Uint8Array(await blob.arrayBuffer()));
  const label = new Uint8ClampedArray(LABEL.w * LABEL.h * 4);
  for (let y = 0; y < LABEL.h; y++) {
    label.set(pixels.subarray(((LABEL.y + y) * W + LABEL.x) * 4, ((LABEL.y + y) * W + LABEL.x + LABEL.w) * 4), y * LABEL.w * 4);
  }
  const crop = { data: label, width: LABEL.w, height: LABEL.h };
  const decoded = QR_SHRINKS.map((scale) => {
    const { data, width, height } = shrinkPixels(crop, scale);
    return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  });
  return { decoded, text };
};

const SITE = 'https://evanlin23.github.io/BrainrotTCG/#/profile/';
/** A profile link of `length` characters (real ones are base64url of the signed run table). */
const linkOf = (length: number) => SITE + 'AbCdEf0123456789-_QrStUvWxYz'.repeat(Math.ceil(length / 27)).slice(0, length - SITE.length);
const FALLBACK = 'Open the link sent with this to check it.';

const realLoad = decoderLoader.load;
afterEach(() => {
  decoder.misread = false;
  decoderLoader.load = realLoad;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('exports a short proof link as a code that decodes to the exact link at every shrink size', async () => {
  const url = 'https://evanlin23.github.io/BrainrotTCG/#/pull/AbCdEf0123456789';
  const { decoded, text } = await exportAndDecode(url);
  expect(decoded).toEqual([url, url]);
  expect(text).not.toContain(FALLBACK);
});

it('exports a dense 407-character profile link as a code that decodes exactly', async () => {
  const url = linkOf(407);
  const { decoded, text } = await exportAndDecode(url);
  expect(decoded).toEqual([url, url]);
  expect(text).toContain('Scan to re-check every pack.');
});

it('exports the densest profile link that still gets a code (492 characters) as one that decodes exactly', async () => {
  const url = linkOf(492);
  const { decoded } = await exportAndDecode(url);
  expect(decoded).toEqual([url, url]);
});

it('draws the code on whole pixels, at least 3 per module, inside its box', async () => {
  for (const length of [80, 200, 407, 492]) {
    const plan = await planQr(linkOf(length));
    expect(plan).not.toBeNull();
    expect(Number.isInteger(plan!.cell)).toBe(true);
    expect(plan!.cell).toBeGreaterThanOrEqual(3);
    expect(plan!.side).toBe((plan!.count + QR_QUIET * 2) * plan!.cell);
    expect(plan!.side).toBeLessThanOrEqual(QR_BOX);
  }
});

it('prints no code and says to open the link when the link is too dense to read back', async () => {
  const url = linkOf(2040);
  const { decoded, text } = await exportAndDecode(url);
  expect(decoded).toEqual([null, null]);
  expect(text).toContain(FALLBACK);
  expect(text).not.toContain('Scan to re-check every pack.');
});

it('prints no code when the decoder cannot read the drawn code back', async () => {
  decoder.misread = true;
  expect(await planQr(linkOf(407))).toBeNull();
  const { text } = stubCanvas();
  await renderProfilePoster(input(linkOf(407)));
  expect(text).toContain(FALLBACK);
  expect(text).not.toContain('Scan to re-check every pack.');
});

it('finishes the poster with the link-text fallback when the decoder chunk never arrives', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  decoderLoader.load = () => new Promise(() => undefined);
  const { text } = stubCanvas();
  let done = false;
  const poster = renderProfilePoster(input(linkOf(407))).then(() => (done = true));
  await vi.advanceTimersByTimeAsync(DECODER_LOAD_MS - 1);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await poster;
  expect(done).toBe(true);
  expect(text).toContain(FALLBACK);
  expect(text).not.toContain('Scan to re-check every pack.');
});

it('finishes the poster with the link-text fallback when the decoder chunk fails to load', async () => {
  decoderLoader.load = () => Promise.reject(new Error('Failed to fetch dynamically imported module'));
  const { text } = stubCanvas();
  await renderProfilePoster(input(linkOf(407)));
  expect(text).toContain(FALLBACK);
  expect(text).not.toContain('Scan to re-check every pack.');
});

it('draws each dark module as an ink cell on the integer grid the decoder was checked on', async () => {
  stubCanvas();
  const pixels = await unpng(new Uint8Array(await (await renderProfilePoster(input(linkOf(407)))).arrayBuffer()));
  const ink = [0x12, 0x11, 0x14];
  const plan = (await planQr(linkOf(407)))!;
  const x0 = LABEL.x + LABEL.w - 40 - plan.side + QR_QUIET * plan.cell;
  const y0 = LABEL.y + Math.round((LABEL.h - plan.side) / 2) + QR_QUIET * plan.cell;
  expect(INK).toBe('#121114');
  for (let r = 0; r < plan.count; r++) {
    for (let c = 0; c < plan.count; c++) {
      // The middle of each module is ink exactly when the module is dark.
      const i = ((y0 + r * plan.cell + 1) * W + x0 + c * plan.cell + 1) * 4;
      expect([...pixels.subarray(i, i + 3)].join() === ink.join()).toBe(plan.isDark(r, c));
    }
  }
});
