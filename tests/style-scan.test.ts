import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Style rules from docs/DESIGN.md (#312 S5), checked across every stylesheet in src since
// component tests don't load CSS: layers come from the z ladder in tokens.css, and no text
// can be set under the 12 px floor.
const src = fileURLToPath(new URL('../src/', import.meta.url));
const sheets = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.css'))
  .map((path) => ({ path, css: readFileSync(join(src, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));

/** Every `property: value` in the sheets whose property matches, as "file: property: value". */
const declarations = (property: RegExp) => sheets.flatMap(({ path, css }) =>
  [...css.matchAll(/(?:^|[;{\s])(--?[\w-]+|[a-z-]+)\s*:\s*([^;{}]+)/g)]
    .filter(([, name]) => property.test(name))
    .map(([, name, value]) => ({ where: `${path}: ${name}: ${value.trim()}`, value: value.trim() })));

const PX: Record<string, number> = { px: 1, rem: 16, em: 16, '%': 0.16 };
const LENGTH = /^(\d*\.?\d+)(px|rem|em|%)$/;
const FLUID = /^\d*\.?\d+(vw|vh|vmin|vmax|svh|dvh|lvh|cqw|cqh|cqi|cqb|cqmin|cqmax)$/;

/**
 * The smallest size a font-size value can reach, in px at the default 16 px root: a literal
 * length, the first argument of clamp(), or the largest literal argument of max(). Fluid units
 * with no literal floor reach 0. `undefined` means the scan can't tell (var(), calc(), keywords).
 */
const floor = (value: string): number | undefined => {
  const length = LENGTH.exec(value);
  if (length) return Number(length[1]) * PX[length[2]];
  if (FLUID.test(value)) return 0;
  const call = /^(clamp|max)\((.*)\)$/.exec(value);
  if (!call) return undefined;
  const args = call[2].split(',').map((arg) => arg.trim());
  if (call[1] === 'clamp') return floor(args[0]);
  const floors = args.map(floor).filter((px) => px !== undefined);
  return floors.length ? Math.max(...floors) : undefined;
};

it('scans the app stylesheets', () => {
  expect(sheets.map(({ path }) => path)).toEqual(expect.arrayContaining(['styles/tokens.css', 'styles/base.css', 'styles/PackOpener.css']));
});

it('keeps raw z-index to 0-3 inside components; anything higher comes from the --z-* ladder', () => {
  const raw = declarations(/^z-index$/).filter(({ value }) => /^-?\d+$/.test(value) && Number(value) > 3);
  expect(raw.map(({ where }) => where)).toEqual([]);
  // The ladder itself: header < nav < pack HUD < sheets < toasts, all above the local 1-3 range.
  const tokens = sheets.find(({ path }) => path === 'styles/tokens.css')!.css;
  const ladder = ['stage-fx', 'header', 'nav', 'hud', 'sheet', 'toast']
    .map((name) => Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(tokens)?.[1]));
  expect(ladder.every((z) => z > 3)).toBe(true);
  expect([...ladder].sort((a, b) => a - b)).toEqual(ladder);
});

it('never sets text under the 12 px floor, in a font size or a --text-* token', () => {
  const sizes = [
    ...declarations(/^font-size$|^--text-/),
    // The font shorthand's size is its first length.
    ...declarations(/^font$/).flatMap(({ where, value }) => {
      const size = /(?:^|\s)(\d*\.?\d+(?:px|rem|em|%))(?=\s|\/|$)/.exec(value)?.[1];
      return size ? [{ where, value: size }] : [];
    }),
  ];
  expect(sizes.length).toBeGreaterThan(10);
  const small = sizes.filter(({ value }) => (floor(value) ?? Infinity) < 12);
  expect(small.map(({ where }) => where)).toEqual([]);
});

it('measures what the rules mean', () => {
  expect(floor('0.75rem')).toBe(12);
  expect(floor('11px')).toBe(11);
  expect(floor('5cqw')).toBe(0);
  expect(floor('max(0.75rem, 2.9cqw)')).toBe(12);
  expect(floor('clamp(0.7rem, 2vw, 1rem)')).toBeCloseTo(11.2);
  expect(floor('var(--text-xs)')).toBeUndefined();
  expect(floor('#b6b0ba')).toBeUndefined();
});
