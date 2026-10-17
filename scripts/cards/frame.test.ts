import { expect, it } from 'vitest';
import { TITLE_STYLE, textOverlaySvg } from './frame.ts';

/** WCAG relative luminance of a #rrggbb colour. */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** The banner's pink behind the title, sampled from templates/genesis-frame.png. */
const BANNER_PINK = '#f750e6';

const svg = textOverlaySvg('Woman Yelling at a Cat', 'Did not order the salad');
const titleLayers = svg.match(/<use href="#title-glyphs"[^>]*>/g) ?? [];
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

it('outlines the title once, in one dark colour, with no light inner stroke', () => {
  expect(titleLayers.length).toBeGreaterThan(0);
  const strokes = new Set(titleLayers.map((tag) => attr(tag, 'stroke')).filter((s) => s !== undefined));
  expect([...strokes]).toEqual([TITLE_STYLE.outline]);
  expect(luminance(TITLE_STYLE.outline)).toBeLessThan(0.05);
  expect(contrast(TITLE_STYLE.outline, BANNER_PINK)).toBeGreaterThanOrEqual(4.5);
});

it('fills the title with a light colour that contrasts with the outline', () => {
  const fill = titleLayers.at(-1)!;
  expect(attr(fill, 'fill')).toBe('url(#title-fill)');
  expect(attr(fill, 'stroke')).toBeUndefined();
  const stops = [...svg.matchAll(/<linearGradient id="title-fill"[\s\S]*?<\/linearGradient>/g)][0][0].match(/stop-color="(#[0-9a-f]{6})"/g)!;
  expect(stops.length).toBeGreaterThan(0);
  for (const stop of stops.map((s) => s.slice(12, 19))) {
    expect(luminance(stop), stop).toBeGreaterThan(0.75);
    expect(contrast(stop, TITLE_STYLE.outline), stop).toBeGreaterThanOrEqual(4.5);
  }
});

it('condenses titles in the outline, so the stroke stays even', () => {
  const long = textOverlaySvg('Willy Wonka Experience', '');
  expect(long).not.toMatch(/scale\(/);
});
