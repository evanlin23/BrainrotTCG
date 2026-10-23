import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { SetDefinition } from '../../src/engine/index.ts';
import { SETS } from '../../src/content/sets/index.ts';
import { EMBLEM, ERA_PLATE, LOGO_PLATE, LOGO_SLOT, LOGO_STYLE, PACK_HEIGHT, PACK_WIDTH, logoLockup, packColours, wrapperSvg } from './pack.ts';

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

it('keeps the logo inside its slot, clear of the flap and the cards', () => {
  expect(LOGO_SLOT.top).toBeGreaterThan(0.19 * PACK_HEIGHT);
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
  // 672px of the 768px frame.
  expect((lockup.text.ink.bottom - lockup.text.ink.top) * (672 / PACK_WIDTH) * (250 / PACK_WIDTH)).toBeGreaterThanOrEqual(14);
});

const withPalette = (palette: string[] | undefined) => ({ ...SETS[0], palette }) as SetDefinition;

it('orders a palette lightest to darkest, and falls back to the house colours when it is missing or invalid', () => {
  const c = packColours(withPalette(['#1A1A2E', '#B6FF00', '#FF2E88']));
  expect([c.hi, c.mid, c.lo]).toEqual(['#B6FF00', '#FF2E88', '#1A1A2E']);
  const fallback = packColours(withPalette(undefined));
  expect(fallback).toEqual(packColours(withPalette(['#ff3df2', 'not a colour', '#ffe14d'])));
  expect([fallback.hi, fallback.mid, fallback.lo]).toEqual(['#ffe14d', '#29f0ff', '#ff3df2']);
});

it('draws one sealed wrapper: no card images or silhouettes, the badge and plates below the flap', () => {
  for (const set of SETS) {
    const { foil, trim } = wrapperSvg(set);
    expect(foil + trim).not.toMatch(/<image|data:image|<foreignObject/);
    expect(foil).not.toContain('NaN');
  }
  const flap = 0.19 * PACK_HEIGHT;
  expect(LOGO_PLATE.y).toBeGreaterThan(flap);
  expect(LOGO_PLATE.y + LOGO_PLATE.h).toBeLessThanOrEqual(EMBLEM.y - EMBLEM.r + 30);
  expect(EMBLEM.y + EMBLEM.r).toBeLessThanOrEqual(ERA_PLATE.y + 30);
  expect(ERA_PLATE.y + ERA_PLATE.h).toBeLessThan(PACK_HEIGHT - 46);
  expect(EMBLEM.x - EMBLEM.r).toBeGreaterThan(0);
  expect(EMBLEM.x + EMBLEM.r).toBeLessThan(PACK_WIDTH);
  // The logo sits on its plate.
  expect(LOGO_SLOT.top).toBeGreaterThanOrEqual(LOGO_PLATE.y);
  expect(LOGO_SLOT.bottom).toBeLessThanOrEqual(LOGO_PLATE.y + LOGO_PLATE.h);
});

it('builds the same wrapper every time, and a different one for each set', () => {
  expect(wrapperSvg(SETS[0])).toEqual(wrapperSvg(SETS[0]));
  const foils = SETS.map((set) => wrapperSvg(set).foil);
  expect(new Set(foils).size).toBe(foils.length);
});
