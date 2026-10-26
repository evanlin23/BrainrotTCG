import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { LOGO_MARK_PATH } from '../src/styles/logoMark.ts';
import { PNG_FILES, SVG_FILES, renderPng } from './logo-icons.ts';

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

it('commits each PNG icon at its size, drawn from the current mark (npm run icons)', async () => {
  for (const [name, spec] of Object.entries(PNG_FILES)) {
    const png = readFileSync(file(name));
    expect(png.subarray(1, 4).toString('latin1'), name).toBe('PNG');
    // The IHDR chunk's width and height.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], name).toEqual([spec.size, spec.size]);
    // Compare pixels, not bytes, so a different PNG encoder can't fail it; a moved square can.
    const pixels = (image: Buffer) => sharp(image).ensureAlpha().raw().toBuffer();
    const [committed, fresh] = await Promise.all([pixels(png), renderPng(spec).then(pixels)]);
    expect(committed.length, name).toBe(fresh.length);
    let worst = 0;
    for (let i = 0; i < fresh.length; i++) worst = Math.max(worst, Math.abs(committed[i] - fresh[i]));
    expect(worst, name).toBeLessThanOrEqual(8);
  }
});

it('links every icon from index.html at a root path, so Vite puts it under either base', () => {
  const html = readFileSync(file('index.html'), 'utf8');
  const links = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((match) => match[1]);
  expect(links.sort()).toEqual(['/apple-touch-icon.png', '/favicon-32.png', '/favicon.svg']);
  for (const href of links) expect(existsSync(file(`public${href}`)), href).toBe(true);
});

it('links the web app manifest and declares all referenced icon files', () => {
  const html = readFileSync(file('index.html'), 'utf8');
  expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" \/>/);

  const manifestPath = file('public/manifest.webmanifest');
  expect(existsSync(manifestPath)).toBe(true);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  expect(manifest.name).toBe('Brainrot TCG');
  expect(manifest.short_name).toBe('Brainrot TCG');
  expect(manifest.display).toBe('standalone');
  expect(manifest.theme_color).toBe('#121114');
  expect(manifest.background_color).toBe('#121114');

  expect(Array.isArray(manifest.icons)).toBe(true);
  expect(manifest.icons.length).toBeGreaterThanOrEqual(4);

  for (const icon of manifest.icons) {
    expect(existsSync(file(`public${icon.src}`)), icon.src).toBe(true);
  }

  const maskable = manifest.icons.filter((icon: { purpose?: string }) => icon.purpose === 'maskable');
  expect(maskable.length).toBeGreaterThanOrEqual(2);
});

it('includes valid JSON-LD structured data and crawlable semantic copy in index.html', () => {
  const html = readFileSync(file('index.html'), 'utf8');

  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(jsonLdMatch).toBeTruthy();
  const jsonLd = JSON.parse(jsonLdMatch![1]);
  expect(jsonLd['@context']).toBe('https://schema.org');
  expect(jsonLd['@type']).toEqual(['WebApplication', 'VideoGame']);
  expect(jsonLd.name).toBe('Brainrot TCG');
  expect(jsonLd.url).toBe('https://brainrottcg.pages.dev/');

  expect(html).toContain('<noscript>');
  expect(html).toContain('Brainrot TCG');
  expect(html).toContain('Brain Rot Trading Card Game');
});
