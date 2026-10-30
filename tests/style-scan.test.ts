import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as palette from '../src/styles/palette';

// Style rules from docs/DESIGN.md (#312 S5, S8a), checked across every stylesheet in src since
// component tests don't load CSS: layers come from the z ladder in tokens.css, no text can be set
// under the 12 px floor, colours come from tokens.css alone, and corners from the radius ladder.
const src = fileURLToPath(new URL('../src/', import.meta.url));
const sheets = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.css'))
  .map((path) => ({ path, css: readFileSync(join(src, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));

/** Every `property: value` in the sheets whose property matches, as "file: property: value". */
const declarations = (property: RegExp) => sheets.flatMap(({ path, css }) =>
  [...css.matchAll(/(?:^|[;{\s])(--?[\w-]+|[a-z-]+)\s*:\s*([^;{}]+)/g)]
    .filter(([, name]) => property.test(name))
    .map(([, name, value]) => ({ path, where: `${path}: ${name}: ${value.trim()}`, value: value.trim() })));

/** The custom properties tokens.css defines on :root, by name. */
const tokens: Record<string, string> = Object.fromEntries(
  [.../:root\s*\{([\s\S]*?)\n\}/.exec(sheets.find(({ path }) => path === 'styles/tokens.css')!.css)![1]
    .matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));

/** A token's value with every var() it uses filled in, without whitespace and in lower case. */
const token = (name: string): string => {
  expect(tokens, name).toHaveProperty([name]);
  return tokens[name].replace(/var\((--[\w-]+)\)/g, (_, ref: string) => token(ref)).replace(/\s+/g, '').toLowerCase();
};
const same = (value: string) => value.replace(/\s+/g, '').toLowerCase();

/** The declarations in a top-level rule with exactly this selector, as written. */
const rule = (path: string, selector: string) => {
  const css = sheets.find((sheet) => sheet.path === path)!.css;
  return new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
};

const PX: Record<string, number> = { px: 1, rem: 16, em: 16, '%': 0.16 };
const LENGTH = /^(\d*\.?\d+)(px|rem|em|%)$/;
const FLUID = /^\d*\.?\d+(vw|vh|vmin|vmax|svh|dvh|lvh|cqw|cqh|cqi|cqb|cqmin|cqmax)$/;

/**
 * The smallest size a font-size value can reach, in px at the default 16 px root: a literal
 * length, a :root token through var() (or the var()'s fallback), the first argument of clamp(),
 * the largest literal argument of max(), or the smallest argument of min(). Fluid units with no
 * literal floor reach 0, and so does a bare 0. `undefined` means the scan can't tell (calc(), a
 * var() that isn't a :root token and has no fallback, keywords), and the scan lets it through.
 */
const floor = (value: string): number | undefined => {
  if (value === '0') return 0;
  const length = LENGTH.exec(value);
  if (length) return Number(length[1]) * PX[length[2]];
  if (FLUID.test(value)) return 0;
  const ref = /^var\((--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value);
  if (ref) {
    const resolved = tokens[ref[1]] ?? ref[2];
    return resolved === undefined ? undefined : floor(resolved);
  }
  const call = /^(clamp|max|min)\((.*)\)$/.exec(value);
  if (!call) return undefined;
  const args = call[2].split(',').map((arg) => arg.trim());
  if (call[1] === 'clamp') return floor(args[0]);
  const floors = args.map(floor);
  if (call[1] === 'min') return floors.includes(undefined) ? undefined : Math.min(...(floors as number[]));
  const known = floors.filter((px) => px !== undefined);
  return known.length ? Math.max(...known) : undefined;
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
  // The two layers everything else must sit under take their places from it, not from a number.
  expect(rule('styles/Sheet.css', '.sheet-root')).toMatch(/z-index:\s*var\(--z-sheet\)/);
  expect(rule('styles/Toasts.css', '.toast-region')).toMatch(/z-index:\s*var\(--z-toast\)/);
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
  expect(floor('min(1rem, 4vw)')).toBe(0);
  expect(floor('min(1rem, 0.8rem)')).toBeCloseTo(12.8);
  expect(floor('var(--text-xs)')).toBe(12);
  expect(floor('var(--local-size, 11px)')).toBe(11);
  expect(floor('var(--local-size)')).toBeUndefined();
  expect(floor('calc(1rem - 2px)')).toBeUndefined();
  expect(floor('#b6b0ba')).toBeUndefined();
  expect(rule('styles/Sheet.css', '.sheet-root')).toContain('position');
});

// Colours: anything written as a colour value outside tokens.css is a drift waiting to happen.
const HEX = /(?<![\w-])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![\w-])/i;
const COLOR_FN = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
// CSS named colours. `transparent`, `currentColor` and the forced-colors system colours (Canvas,
// CanvasText, Highlight...) aren't here: they follow the theme rather than fix a colour.
const NAMED = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
  blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan
  darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
  darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
  darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
  forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink
  indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral
  lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta
  maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
  mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
  navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
  paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
  rosybrown royalblue saddlebrown salmon seagreen seashell sienna silver skyblue slateblue slategray
  slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke
  yellow yellowgreen`.split(/\s+/));
const named = (value: string) => [...value.matchAll(/(?<![\w-])([a-z]+)(?![\w-])/gi)].some(([word]) => NAMED.has(word.toLowerCase()));

/** Colour literals the scan allows outside tokens.css, each with the reason it can't be a token. */
const COLOUR_ALLOWLIST: { sheet: string; literal: RegExp; reason: string }[] = [];

it('takes every colour from tokens.css, apart from a short allowlist with reasons', () => {
  const values = declarations(/./).filter(({ path }) => path !== 'styles/tokens.css');
  expect(values.length).toBeGreaterThan(500);
  const allowed = new Set<string>();
  const raw = values.filter(({ path, value }) => {
    const rest = COLOUR_ALLOWLIST.filter(({ sheet }) => sheet === path).reduce((left, { literal, reason }) => {
      const kept = left.replace(literal, '');
      if (kept !== left) allowed.add(reason);
      return kept;
    }, value);
    return HEX.test(rest) || COLOR_FN.test(rest) || named(rest);
  });
  expect(raw.map(({ where }) => where)).toEqual([]);
  // A stale allowlist entry hides nothing, so it goes.
  expect(COLOUR_ALLOWLIST.map(({ reason }) => reason).filter((reason) => !allowed.has(reason))).toEqual([]);
  // The retired yellows stay retired: one price-sticker yellow, --brand.
  expect(sheets.filter(({ css }) => /--brand-[23]\b/.test(css)).map(({ path }) => path)).toEqual([]);
});

it('spots what the colour scan means', () => {
  expect(HEX.test('0 0 0 1px #fff')).toBe(true);
  expect(HEX.test('url(#clip)')).toBe(false);
  expect(COLOR_FN.test('rgba(0, 0, 0, 0.5)')).toBe(true);
  expect(COLOR_FN.test('color-mix(in srgb, var(--brand), transparent)')).toBe(false);
  expect(named('1px solid white')).toBe(true);
  expect(named('var(--finish-silver)')).toBe(false);
  expect(named('transparent')).toBe(false);
  expect(named('CanvasText')).toBe(false);
});

// Radii: 4 / 6 / 10 / 14 / pill, as --radius-sm, -md, -lg, -xl and -pill.
const RADIUS_OK = /^(?:var\(--radius-(?:sm|md|lg|xl|pill)\)|0|50%|inherit)$/;
/** Off-ladder radii the scan allows, each with the reason it can't be a step. */
const RADIUS_ALLOWLIST: { sheet: string; radius: string; reason: string }[] = [];

it('keeps every corner on the radius ladder, apart from a short allowlist with reasons', () => {
  expect(['sm', 'md', 'lg', 'xl', 'pill'].map((step) => tokens[`--radius-${step}`])).toEqual(['4px', '6px', '10px', '14px', '999px']);
  const radii = declarations(/^border(?:-[a-z]+)*-radius$/);
  expect(radii.length).toBeGreaterThan(50);
  const allowed = new Set<string>();
  const off = radii.filter(({ path, value }) => !value.split(/\s*\/\s*|\s+/).every((part) => {
    if (RADIUS_OK.test(part)) return true;
    const entry = RADIUS_ALLOWLIST.find(({ sheet, radius }) => sheet === path && radius === part);
    if (entry) allowed.add(entry.reason);
    return entry !== undefined;
  }));
  expect(off.map(({ where }) => where)).toEqual([]);
  expect(RADIUS_ALLOWLIST.map(({ reason }) => reason).filter((reason) => !allowed.has(reason))).toEqual([]);
});

// Canvas can't read CSS variables, so src/styles/palette.ts mirrors the tokens it paints with.
it('keeps the canvas palette in step with tokens.css', () => {
  const pairs: [string, string][] = [
    ['--bg', palette.INK],
    ['--text', palette.PAPER],
    ['--text-muted', palette.MUTED],
    ['--brand', palette.BRAND],
    ['--chip-bg', palette.CHIP_BG],
    ...Object.entries(palette.RARITY_COLORS).map(([rarity, colour]): [string, string] =>
      [rarity === 'BRAINROT' ? '--rarity-brainrot-solid' : `--rarity-${rarity.toLowerCase()}`, colour]),
    ...Object.entries(palette.FINISH_COLORS).map(([finish, colour]): [string, string] => [`--finish-${finish.toLowerCase()}`, colour]),
    ['--finish-platinum-glow', palette.FINISH_GLOWS.PLATINUM],
    ['--finish-diamond-glow', palette.FINISH_GLOWS.DIAMOND],
    ['--finish-diamond-glow-2', palette.FINISH_GLOWS.DIAMOND_2],
  ];
  expect(pairs.filter(([name, value]) => token(name) !== same(value))).toEqual([]);
  // The foil runs pink, brand, mint, blue, violet; the canvas closes it back to pink.
  expect(palette.FOIL_STOPS.map(same)).toEqual(['--foil-pink', '--brand', '--foil-mint', '--foil-blue', '--foil-violet', '--foil-pink'].map(token));
  expect(same(tokens['--foil'])).toBe(
    'linear-gradient(var(--foil-angle),var(--foil-pink),var(--brand)30%,var(--foil-mint)55%,var(--foil-blue)80%,var(--foil-violet))');
});

it('styles select dropdowns in base.css and keeps other stylesheets from overriding core styles', () => {
  const selectRule = rule('styles/base.css', 'select');
  expect(selectRule).toMatch(/appearance:\s*none/);
  expect(selectRule).toMatch(/-webkit-appearance:\s*none/);
  expect(selectRule).toMatch(/color-scheme:\s*dark/);
  expect(selectRule).toMatch(/--select-chevron:\s*16px/);
  expect(selectRule).toMatch(/padding:\s*0\s+calc\(var\(--space-2\)\s*\+\s*var\(--select-chevron\)\s*\+\s*var\(--space-2\)\)\s*0\s*var\(--space-3\)/);

  // Chevron stroke matches --text-muted
  const strokeMatch = /stroke="(?:%23|#)([0-9a-fA-F]{6})"/.exec(selectRule);
  expect(strokeMatch).toBeTruthy();
  expect(`#${strokeMatch![1].toLowerCase()}`).toBe(token('--text-muted'));

  // Forced colors restore native dropdown parsed by brace matching
  const baseCss = sheets.find((s) => s.path === 'styles/base.css')!.css;
  const mediaIndex = baseCss.indexOf('@media (forced-colors: active)');
  expect(mediaIndex).toBeGreaterThan(-1);
  let depth = 0;
  let mediaBlock = '';
  for (let i = baseCss.indexOf('{', mediaIndex); i < baseCss.length; i++) {
    if (baseCss[i] === '{') depth++;
    else if (baseCss[i] === '}') {
      depth--;
      if (depth === 0) {
        mediaBlock = baseCss.slice(mediaIndex, i + 1);
        break;
      }
    }
  }
  expect(mediaBlock).toMatch(/select\s*\{[^}]*appearance:\s*auto/);

  // Scan every other stylesheet: any rule targeting select or .collection-select can only override border-radius or width
  const violations: string[] = [];
  for (const { path, css } of sheets) {
    if (path === 'styles/base.css') continue;
    const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectorStr, body] of cleanCss.matchAll(/(?:^|[{}])\s*([^{}]+?)\s*\{([^{}]+)\}/g)) {
      if (selectorStr.trim().startsWith('@')) continue;
      const selectors = selectorStr.split(',').map((s) => s.trim());
      const targetsSelect = selectors.some((s) => {
        const stripped = s.replace(/:[\w-]+(?:\([^)]*\))?/g, '').trim();
        return /(?:^|[\s>+~])(?:select(?:\.[a-zA-Z0-9_-]+)*|\.collection-select)$/.test(stripped);
      });
      if (!targetsSelect) continue;
      for (const [, prop] of body.matchAll(/(?:^|[;{\s])([\w-]+)\s*:/g)) {
        if (prop !== 'border-radius' && prop !== 'width') {
          violations.push(`${path}: ${selectorStr.trim()} sets ${prop}`);
        }
      }
    }
  }
  expect(violations).toEqual([]);
});
