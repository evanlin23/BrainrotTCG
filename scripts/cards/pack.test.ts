import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { SetDefinition } from '../../src/engine/index.ts';
import { SETS } from '../../src/content/sets/index.ts';
import { SETS_DIR } from './lib.ts';

// Every input sharp opens and every composite it runs, so the build test sees what the pack is made of.
const opened = vi.hoisted(() => [] as unknown[]);
type Overlay = { input: unknown; left?: number; top?: number };
const composited = vi.hoisted(() => [] as Overlay[][]);
vi.mock('sharp', async (importOriginal) => {
  // sharp's default export is its constructor, callable without `new`.
  const real = (await importOriginal<{ default: unknown }>()).default as ((...args: unknown[]) => unknown) & {
    prototype: { composite: (this: unknown, images: Overlay[]) => unknown };
  };
  const composite = real.prototype.composite;
  real.prototype.composite = function (this: unknown, images: Overlay[]) {
    composited.push(images);
    return composite.call(this, images);
  };
  return {
    default: new Proxy(real, {
      apply: (target, self, args) => {
        opened.push(args[0]);
        return Reflect.apply(target, self, args);
      },
    }),
  };
});

const {
  BODY,
  EMBLEM,
  ERA_PLATE,
  FLAP,
  LOGO_CUT,
  LOGO_SLOT,
  LOGO_STYLE,
  PACK_HEIGHT,
  PACK_WIDTH,
  STICKER_COUNT,
  TEAR_LINE,
  buildSetPack,
  faceLayers,
  logoLockup,
  packColours,
  stickerIndex,
  stickerPlan,
  wrapperSvg,
} = await import('./pack.ts');
const sharp = (await import('sharp')).default;

const css = (file: string) => readFileSync(new URL(`../../src/styles/${file}`, import.meta.url), 'utf8');
const token = (name: string) => css('tokens.css').match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
const appLogo = css('index.css').match(/\.app-logo\s*\{([^}]*)\}/)?.[1] ?? '';

const lockup = logoLockup();
const points = (d: string) => {
  const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i], n[2 * i + 1]]);
};

it("matches the site header's wordmark", () => {
  expect(LOGO_STYLE.face).toBe(token('--text'));
  expect(LOGO_STYLE.ink).toBe(token('--brand-ink'));
  expect(LOGO_STYLE.brand).toBe(token('--brand'));
  expect(appLogo).toContain(`letter-spacing: ${LOGO_STYLE.tracking}em`);
  expect(appLogo).toContain(
    `text-shadow: ${LOGO_STYLE.inkOffset}em ${LOGO_STYLE.inkOffset}em 0 var(--brand-ink), ${LOGO_STYLE.brandOffset}em ${LOGO_STYLE.brandOffset}em 0 var(--brand)`,
  );
  expect(css('index.css')).toMatch(new RegExp(`\\.title-space\\s*\\{[^}]*width: ${LOGO_STYLE.space}em`));
  expect(css('tokens.css')).toMatch(/--font-logo:[^;]*RubikGlitch/);
});

it('draws the wordmark as Rubik Glitch paths, misprinted ink then brand under the face', () => {
  expect(lockup.svg).not.toContain('<text');
  expect(lockup.text.d).not.toContain('NaN');
  // Eleven letters, each at least one contour.
  expect((lockup.text.d.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(11);
  const layers = [...lockup.svg.matchAll(/<use href="#logo" x="([\d.]+)" y="([\d.]+)" fill="([^"]+)"/g)];
  expect(layers.map((m) => m[3])).toEqual([LOGO_STYLE.brand, LOGO_STYLE.ink, LOGO_STYLE.face]);
  expect(layers.map((m) => Number(m[1]))).toEqual([LOGO_STYLE.brandOffset, LOGO_STYLE.inkOffset, 0].map((o) => Number((o * lockup.size).toFixed(2))));
});

it("puts the flap's edge below the pack opener's tear line", () => {
  const hook = readFileSync(new URL('../../src/hooks/usePackCutter.ts', import.meta.url), 'utf8');
  expect(hook).toMatch(new RegExp(`const TEAR_LINE_RATIO = ${TEAR_LINE};`));
  // The seam is TEAR_LINE down the whole frame; the face is drawn PACK_HEIGHT tall, then scaled into BODY.
  const seamOnFace = ((TEAR_LINE * PACK_HEIGHT - BODY.y) * PACK_HEIGHT) / BODY.h;
  expect(FLAP).toBeGreaterThan(seamOnFace);
  expect(FLAP).toBeLessThan(seamOnFace + 16);
});

it('keeps the logo sticker inside its slot, below the flap', () => {
  // The die-cut rings round the mark stay below the flap too.
  expect(LOGO_SLOT.top - LOGO_CUT.backing - LOGO_CUT.white - LOGO_CUT.edge).toBeGreaterThan(FLAP);
  const misprint = LOGO_STYLE.brandOffset * lockup.size;
  const text = points(lockup.text.d);
  const xs = text.map(([x]) => x);
  const ys = text.map(([, y]) => y);
  expect(Math.min(...xs)).toBeGreaterThanOrEqual((PACK_WIDTH - LOGO_SLOT.width) / 2);
  expect(Math.max(...xs) + misprint).toBeLessThanOrEqual((PACK_WIDTH + LOGO_SLOT.width) / 2);
  expect(Math.max(...ys) + misprint).toBeLessThanOrEqual(LOGO_SLOT.bottom);
  expect(lockup.mark.y).toBe(LOGO_SLOT.top);
  expect(lockup.mark.y + lockup.mark.size).toBeLessThan(Math.min(...ys));
  // Legible at the opener's smallest pack, 250px wide on a phone: 14px caps or more. The face fills
  // BODY.w of the PACK_WIDTH frame.
  expect((lockup.text.ink.bottom - lockup.text.ink.top) * (BODY.w / PACK_WIDTH) * (250 / PACK_WIDTH)).toBeGreaterThanOrEqual(14);
});

const withPalette = (palette: string[] | undefined) => ({ ...SETS[0], palette }) as SetDefinition;

it('orders a palette lightest to darkest, and falls back to the house colours when it is missing or invalid', () => {
  const c = packColours(withPalette(['#1A1A2E', '#B6FF00', '#FF2E88']));
  expect([c.hi, c.mid, c.lo]).toEqual(['#B6FF00', '#FF2E88', '#1A1A2E']);
  const fallback = packColours(withPalette(undefined));
  expect(fallback).toEqual(packColours(withPalette(['#ff3df2', 'not a colour', '#ffe14d'])));
  expect([fallback.hi, fallback.mid, fallback.lo]).toEqual(['#ffe14d', '#29f0ff', '#ff3df2']);
});

it('draws the foil and trim as vectors only, the starburst and era plate inside the pack', () => {
  for (const set of SETS) {
    const { foil, trim } = wrapperSvg(set);
    expect(foil + trim).not.toMatch(/<image|data:image|<foreignObject/);
    expect(foil + trim).not.toContain('NaN');
  }
  expect(EMBLEM.y - EMBLEM.r).toBeGreaterThan(FLAP);
  expect(EMBLEM.y + EMBLEM.r).toBeLessThanOrEqual(ERA_PLATE.y + 30);
  expect(ERA_PLATE.y + ERA_PLATE.h).toBeLessThan(PACK_HEIGHT - 46);
  expect(EMBLEM.x - EMBLEM.r).toBeGreaterThan(0);
  expect(EMBLEM.x + EMBLEM.r).toBeLessThan(PACK_WIDTH);
  expect(LOGO_SLOT.top).toBeGreaterThan(EMBLEM.y - EMBLEM.r);
  expect(LOGO_SLOT.bottom).toBeLessThan(EMBLEM.y + EMBLEM.r);
  const foils = SETS.map((set) => wrapperSvg(set).foil);
  expect(new Set(foils).size).toBe(foils.length);
  expect(wrapperSvg(SETS[0])).toEqual(wrapperSvg(SETS[0]));
});

const imageSize = async (file: string) => {
  const { width, height } = await sharp(file).metadata();
  return { width: width!, height: height! };
};
const genesisFrame = JSON.parse(readFileSync(new URL('./templates/genesis-frame.json', import.meta.url), 'utf8'));

it("cuts every set's stickers from that set's own current art, never a built card face", async () => {
  for (const set of SETS) {
    const index = stickerIndex(set.id);
    expect(Object.keys(index).sort()).toEqual(set.cards.map((c) => c.id).sort());
    for (const [card, s] of Object.entries(index)) {
      const where = `${set.id}/${card}`;
      // The card's own illustration, as scripts/cards/lib.ts finds it (a `.card` file is a whole Genesis card).
      expect(s.art, where).toMatch(new RegExp(`^art/${card}(\\.card)?\\.(png|jpe?g|webp)$`));
      const file = `${SETS_DIR}/${set.id}/${s.art}`;
      // Cut from the art as it is now: re-run cut-stickers.py when art changes.
      expect(createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16), where).toBe(s.source);
    }
    const cut = Object.entries(index).filter(([, s]) => s.kind !== 'skip');
    expect(cut.length).toBeGreaterThanOrEqual(8);
    for (const [card, s] of cut) {
      const where = `${set.id}/${card}`;
      const [x, y, w, h] = s.crop!;
      const size = await imageSize(`${SETS_DIR}/${set.id}/${s.art}`);
      // A whole Genesis card: only its art window, never its frame or title.
      const box = s.art.includes('.card.')
        ? {
            x: (genesisFrame.art.x * size.width) / genesisFrame.width,
            y: (genesisFrame.art.y * size.height) / genesisFrame.height,
            w: (genesisFrame.art.width * size.width) / genesisFrame.width,
            h: (genesisFrame.art.height * size.height) / genesisFrame.height,
          }
        : { x: 0, y: 0, w: size.width, h: size.height };
      expect(x, where).toBeGreaterThanOrEqual(box.x);
      expect(y, where).toBeGreaterThanOrEqual(box.y);
      expect(x + w, where).toBeLessThanOrEqual(box.x + box.w);
      expect(y + h, where).toBeLessThanOrEqual(box.y + box.h);
      expect(Math.min(w, h), where).toBeGreaterThan(60);
      expect(['die', 'round', 'rect'], where).toContain(s.kind);
      // Die-cut characters have a mask; round and rounded-rect stickers are drawn from their shape.
      expect(s.mask, where).toBe(s.kind === 'die' ? `${card}.png` : undefined);
    }
    for (const [card, s] of cut.filter(([, s]) => s.kind === 'die')) {
      const mask = await imageSize(`${SETS_DIR}/${set.id}/stickers/${s.mask}`);
      expect(Math.max(mask.width, mask.height), card).toBeLessThanOrEqual(360);
      // The mask is the crop, scaled down.
      expect(Math.abs(mask.width / mask.height - s.crop![2] / s.crop![3]), card).toBeLessThan(0.05);
    }
  }
});

it('picks 8 to 12 stickers per set, the same ones every time, characters before flat stickers', () => {
  const plans = SETS.map((set) => stickerPlan(set));
  SETS.forEach((set, i) => {
    const plan = plans[i];
    const index = stickerIndex(set.id);
    expect(plan.length).toBeGreaterThanOrEqual(8);
    expect(plan.length).toBeLessThanOrEqual(STICKER_COUNT);
    expect(STICKER_COUNT).toBe(12);
    expect(new Set(plan.map((s) => s.card)).size).toBe(plan.length);
    expect(plan.every((s) => set.cards.some((c) => c.id === s.card) && s.kind !== 'skip')).toBe(true);
    // A flat sticker only once every die-cut character is in.
    const dieCuts = Object.values(index).filter((s) => s.kind === 'die').length;
    expect(plan.filter((s) => s.kind === 'die').length).toBe(Math.min(dieCuts, plan.length));
    expect(stickerPlan(set)).toEqual(plan);
  });
  const mixes = plans.map((plan) => plan.map((s) => `${s.card}@${s.x},${s.y},${s.rot}`).join(' '));
  expect(new Set(mixes).size).toBe(SETS.length);
});

const scratch = mkdtempSync(path.join(os.tmpdir(), 'pack-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it("builds the pack from the foil, its planned stickers' art, the logo and the trim, rendering the same layers every time", async () => {
  const set = SETS.find((s) => s.id === 'web-ancients')!;
  const plan = stickerPlan(set);
  const expected = await faceLayers(set);
  expect(expected.layers.map((l) => l.name)).toEqual([...plan.map((s) => `sticker:${s.card}`), 'logo', 'trim']);
  for (const layer of expected.layers.filter((l) => l.name.startsWith('sticker:'))) {
    // Below the flap, and inside the face (bleeding off the pack's edge is clipped here, not in the margin).
    const { width, height } = await sharp(layer.input).metadata();
    expect(layer.top).toBeGreaterThanOrEqual(FLAP);
    expect(layer.left).toBeGreaterThanOrEqual(0);
    expect(layer.left + width!).toBeLessThanOrEqual(PACK_WIDTH);
    expect(layer.top + height!).toBeLessThanOrEqual(PACK_HEIGHT);
  }

  opened.length = 0;
  composited.length = 0;
  const manifest: Record<string, string> = {};
  expect(await buildSetPack(set, manifest, true, scratch)).toBe(true);
  // The face is the foil with exactly these layers on it, byte for byte.
  expect(opened).toContainEqual(expected.foil);
  const face = composited.find((images) => images.length === expected.layers.length && images.every((im, i) => Buffer.isBuffer(im.input) && im.input.equals(expected.layers[i].input)));
  expect(face?.map(({ left, top }) => [left, top])).toEqual(expected.layers.map(({ left, top }) => [left, top]));
  // The only files it reads are the planned stickers' art and masks (and then its own pack.webp, for the thumbnail).
  const files = new Set(opened.filter((input): input is string => typeof input === 'string'));
  const art = plan.flatMap((s) => [`${SETS_DIR}/${set.id}/${s.art}`, ...(s.mask ? [`${SETS_DIR}/${set.id}/stickers/${s.mask}`] : [])]);
  expect([...files].sort()).toEqual([...new Set([...art, `${scratch}/pack.webp`])].sort());
  expect([...files].some((f) => f.includes('/cards/'))).toBe(false);

  expect(await sharp(`${scratch}/pack.webp`).metadata()).toMatchObject({ width: PACK_WIDTH, height: PACK_HEIGHT });
  expect(await sharp(`${scratch}/pack-thumb.webp`).metadata()).toMatchObject({ width: 300, height: 533 });
  // Up to date now; and the committed pack is this build, byte for byte.
  expect(await buildSetPack(set, manifest, false, scratch)).toBe(false);
  expect(existsSync(`${SETS_DIR}/${set.id}/pack.webp`)).toBe(true);
  const committed = JSON.parse(readFileSync(`${SETS_DIR}/${set.id}/cards/.manifest.json`, 'utf8'))['(pack)'];
  expect(manifest['(pack)']).toBe(committed);
}, 60_000);
