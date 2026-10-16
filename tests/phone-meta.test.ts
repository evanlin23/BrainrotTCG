import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Phone chrome in index.html (#312 S6): the page runs under the notch, keeps pinch zoom, and the
// browser bar matches the page background token, read from the CSS so the two can't drift.
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const html = read('index.html');
const meta = (name: string) => html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`))?.[1];

it('extends the page under the notch without locking zoom', () => {
  const viewport = meta('viewport');
  expect(viewport).toBeDefined();
  const settings = Object.fromEntries(viewport!.split(',').map((part) => part.trim().split('=').map((side) => side.trim())));
  expect(settings).toMatchObject({ width: 'device-width', 'viewport-fit': 'cover' });
  expect(settings).not.toHaveProperty('maximum-scale');
  expect(settings).not.toHaveProperty('user-scalable');
});

it('colours the browser bar with the page background token', () => {
  const background = read('src/styles/tokens.css').match(/^\s*--bg:\s*(#[0-9a-f]{3,8})\s*;/im)?.[1];
  expect(background).toBeDefined();
  expect(meta('theme-color')?.toLowerCase()).toBe(background!.toLowerCase());
});
