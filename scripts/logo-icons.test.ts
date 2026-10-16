import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { LOGO_MARK_PATH } from '../src/styles/logoMark.ts';
import { PNG_FILES, SVG_FILES } from './logo-icons.ts';

const file = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

it('draws the mark as nine closed squares', () => {
  const squares = LOGO_MARK_PATH.split('M').slice(1);
  expect(squares).toHaveLength(9);
  for (const square of squares) {
    expect(square.trim().endsWith('Z')).toBe(true);
    expect(square.replace('Z', '').trim().split(/\s+/)).toHaveLength(8);
  }
});

it('keeps the committed SVGs in step with the mark (npm run icons)', () => {
  for (const [name, svg] of Object.entries(SVG_FILES)) expect(readFileSync(file(name), 'utf8'), name).toBe(svg);
});

it('commits each PNG icon at its size', () => {
  for (const [name, { size }] of Object.entries(PNG_FILES)) {
    const png = readFileSync(file(name));
    expect(png.subarray(1, 4).toString('latin1'), name).toBe('PNG');
    // The IHDR chunk's width and height.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], name).toEqual([size, size]);
  }
});

it('links every icon from index.html at a root path, so Vite puts it under either base', () => {
  const html = readFileSync(file('index.html'), 'utf8');
  const links = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((match) => match[1]);
  expect(links.sort()).toEqual(['/apple-touch-icon.png', '/favicon-32.png', '/favicon.svg']);
  for (const href of links) expect(existsSync(file(`public${href}`)), href).toBe(true);
});
