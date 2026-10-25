import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { SetDefinition } from '../../src/engine/index.ts';
import { SETS } from '../../src/content/sets/index.ts';
import { SETS_DIR } from './lib.ts';

// Every input sharp opens, so the build test sees which files the pack is made of.
const opened = vi.hoisted(() => [] as unknown[]);
vi.mock('sharp', async (importOriginal) => {
  // sharp's default export is its constructor, callable without `new`.
  const real = (await importOriginal<{ default: unknown }>()).default as (...args: unknown[]) => unknown;
  return {
    default: new Proxy(real, {
      apply: (target, self, args) => {
        opened.push(args[0]);
        return Reflect.apply(target, self, args);
      },
    }),
  };
});

const { BODY, FLAP, HERO, NAME, PACK_HEIGHT, PACK_WIDTH, TEAR_LINE, buildSetPack, heroCard, heroSource, heroSticker, nameLayout, nameLines, packColours, packHeroes, vivid } = await import('./pack.ts');
const sharp = (await import('sharp')).default;

const stickersOf = (setId: string) => JSON.parse(readFileSync(`${SETS_DIR}/${setId}/stickers/index.json`, 'utf8'));
const withPalette = (palette: string[] | undefined) => ({ ...SETS[0], palette }) as SetDefinition;

it("puts the flap's edge below the pack opener's tear line", () => {
  const hook = readFileSync(new URL('../../src/hooks/usePackCutter.ts', import.meta.url), 'utf8');
  expect(hook).toMatch(new RegExp(`const TEAR_LINE_RATIO = ${TEAR_LINE};`));
  // The seam is TEAR_LINE down the whole frame; the face is drawn PACK_HEIGHT tall, then scaled into BODY.
  const seamOnFace = ((TEAR_LINE * PACK_HEIGHT - BODY.y) * PACK_HEIGHT) / BODY.h;
  expect(FLAP).toBeGreaterThan(seamOnFace);
  expect(FLAP).toBeLessThan(seamOnFace + 16);
});

it('makes the field from the first two palette colours, vivid, and falls back to the house colours', () => {
  const [a, b] = packColours(withPalette(['#1A1A2E', '#B6FF00', '#FF2E88']));
  expect(a).toEqual(vivid([0x1a, 0x1a, 0x2e]));
  expect(b).toEqual(vivid([0xb6, 0xff, 0x00]));
  // Vivid: bright, and never less saturated than its floor.
  for (const c of [a, b]) expect(Math.max(...c)).toBeGreaterThanOrEqual(244);
  const fallback = packColours(withPalette(undefined));
  expect(fallback).toEqual(packColours(withPalette(['#ff3df2', 'not a colour', '#29f0ff'])));
  expect(fallback).toEqual([vivid([0xff, 0x3d, 0xf2]), vivid([0x29, 0xf0, 0xff])]);
});

it("names one hero per set, from that set's own cards", () => {
  expect(Object.keys(packHeroes()).sort()).toEqual(SETS.map((s) => s.id).sort());
  for (const set of SETS) {
    expect(set.cards.map((c) => c.id), set.id).toContain(heroCard(set.id));
  }
  // No two sets share a hero.
  expect(new Set(Object.values(packHeroes())).size).toBe(SETS.length);
});

it('names the missing step: the hero config first, then the sticker cut', () => {
  const set = SETS[0].id;
  // A new set with no hero entry (and no stickers folder) is told to configure the hero, not to cut.
  expect(() => heroSource('brand-new-set', {})).toThrow(/brand-new-set has no hero: add it to scripts\/cards\/pack-heroes\.json/);
  // A hero with no stickers folder, or no sticker entry in a real set's index, is told to cut.
  expect(() => heroSource('brand-new-set', { 'brand-new-set': 'x' })).toThrow(/has no hero cut: run scripts\/cards\/cut-stickers\.py --set brand-new-set/);
  expect(() => heroSource(set, { [set]: 'not-a-card' })).toThrow(new RegExp(`has no die-cut mask: run scripts/cards/cut-stickers\\.py --set ${set}`));
});

it("cuts each hero from that set's own current art, with nothing else committed", () => {
  for (const set of SETS) {
    const hero = heroCard(set.id);
    const where = `${set.id}/${hero}`;
    const index = stickersOf(set.id);
    // Only the hero is kept, and its mask is the only file beside the index.
    expect(Object.keys(index.stickers), where).toEqual([hero]);
    const entry = heroSource(set.id);
    expect(entry.kind, where).toBe('die');
    expect(entry.mask, where).toBe(`${hero}.png`);
    expect(readdirSync(`${SETS_DIR}/${set.id}/stickers`).sort(), where).toEqual([entry.mask, 'index.json'].sort());
    // The card's own illustration, as scripts/cards/lib.ts finds it (a `.card` file is a whole Genesis card), never a built face.
    expect(entry.art, where).toMatch(new RegExp(`^art/${hero}(\\.card)?\\.(png|jpe?g|webp)$`));
    // Cut from the art as it is now: re-run cut-stickers.py when art changes.
    const bytes = readFileSync(`${SETS_DIR}/${set.id}/${entry.art}`);
    expect(createHash('sha256').update(bytes).digest('hex').slice(0, 16), where).toBe(entry.source);
    // A cut the grades flag is only kept by a hand call, listed in the index.
    if (entry.flag) expect(index.overrides, where).toEqual({ [hero]: 'die' });
    else expect(index.overrides, where).toEqual({});
  }
});

it('keeps each hero below the flap and inside the face, and its mask the crop scaled down', async () => {
  for (const set of SETS) {
    const where = set.id;
    const entry = heroSource(set.id);
    const hero = await heroSticker(set.id, entry);
    // The sticker box includes its outline pad and shadow; the cut itself sits inside it.
    expect(hero.top + HERO.pad, where).toBeGreaterThan(FLAP);
    expect(hero.left, where).toBeGreaterThanOrEqual(0);
    expect(hero.left + hero.width, where).toBeLessThanOrEqual(PACK_WIDTH);
    expect(hero.top + hero.height, where).toBeLessThanOrEqual(NAME.y);
    expect(Math.max(hero.width, hero.height) - 2 * HERO.pad, where).toBeLessThanOrEqual(HERO.size);
    const mask = await sharp(`${SETS_DIR}/${set.id}/stickers/${entry.mask}`).metadata();
    expect(Math.max(mask.width!, mask.height!), where).toBeLessThanOrEqual(360);
    expect(Math.abs(mask.width! / mask.height! - entry.crop[2] / entry.crop[3]), where).toBeLessThan(0.05);
  }
});

it("sets every set's name in at most two lines, below the hero and inside the face", () => {
  for (const set of SETS) {
    const where = set.id;
    const { size, lines } = nameLayout(set.name);
    expect(lines.length, where).toBeLessThanOrEqual(2);
    expect(lines.map((l) => l.text).join(' '), where).toBe(set.name.toUpperCase().split(/\s+/).join(' '));
    expect(size, where).toBeLessThanOrEqual(NAME.size);
    for (const line of lines) {
      expect(line.ink.right - line.ink.left, where).toBeLessThanOrEqual(NAME.maxWidth);
      // The outline and the extrusion are drawn past the letters.
      const reach = NAME.stroke + NAME.depth;
      expect(line.ink.left - reach, where).toBeGreaterThanOrEqual(0);
      expect(line.ink.right + reach, where).toBeLessThanOrEqual(PACK_WIDTH);
      expect(line.ink.top, where).toBeGreaterThan(FLAP);
      expect(line.ink.bottom + reach, where).toBeLessThanOrEqual(PACK_HEIGHT - 60);
    }
    // Centred on the face.
    const left = Math.min(...lines.map((l) => l.ink.left));
    const right = Math.max(...lines.map((l) => l.ink.right));
    expect(Math.abs((left + right) / 2 - PACK_WIDTH / 2), where).toBeLessThan(8);
  }
  // A long name shrinks to fit rather than running off the pack.
  const long = nameLines('Supercalifragilistic Extraordinarily Long Brainrot Season Name');
  expect(long.lines.length).toBeLessThanOrEqual(2);
  expect(long.size).toBeLessThan(NAME.size);
});

const scratch = mkdtempSync(path.join(os.tmpdir(), 'pack-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it("builds the pack from the hero's art and mask alone, the same bytes every time, and rebuilds only when an input changes", async () => {
  const set = SETS.find((s) => s.id === 'web-ancients')!;
  const entry = heroSource(set.id);
  opened.length = 0;
  const manifest: Record<string, string> = {};
  const first = path.join(scratch, 'first');
  mkdirSync(first);
  expect(await buildSetPack(set, manifest, true, first)).toBe(true);
  // The only files it reads are the hero's art and mask (and then its own pack.webp, for the thumbnail).
  const files = new Set(opened.filter((input): input is string => typeof input === 'string'));
  expect([...files].sort()).toEqual([`${SETS_DIR}/${set.id}/${entry.art}`, `${SETS_DIR}/${set.id}/stickers/${entry.mask}`, `${first}/pack.webp`].sort());
  expect([...files].some((f) => f.includes('/cards/'))).toBe(false);

  expect(await sharp(`${first}/pack.webp`).metadata()).toMatchObject({ width: PACK_WIDTH, height: PACK_HEIGHT });
  expect(await sharp(`${first}/pack-thumb.webp`).metadata()).toMatchObject({ width: 300, height: 533 });
  // Transparent margins round an opaque pouch.
  const { data, info } = await sharp(`${first}/pack.webp`).raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
  expect(alphaAt(4, 4)).toBe(0);
  expect(alphaAt(PACK_WIDTH - 5, PACK_HEIGHT - 5)).toBe(0);
  expect(alphaAt(PACK_WIDTH / 2, PACK_HEIGHT / 2)).toBe(255);

  // Up to date; rebuilt in full gives the same bytes; and the committed pack was built from these inputs.
  expect(await buildSetPack(set, manifest, false, first)).toBe(false);
  const second = path.join(scratch, 'second');
  mkdirSync(second);
  const again: Record<string, string> = {};
  expect(await buildSetPack(set, again, true, second)).toBe(true);
  expect(readFileSync(`${second}/pack.webp`).equals(readFileSync(`${first}/pack.webp`))).toBe(true);
  expect(again['(pack)']).toBe(manifest['(pack)']);
  expect(existsSync(`${SETS_DIR}/${set.id}/pack.webp`)).toBe(true);
  const committed = JSON.parse(readFileSync(`${SETS_DIR}/${set.id}/cards/.manifest.json`, 'utf8'))['(pack)'];
  expect(manifest['(pack)']).toBe(committed);

  // A new name is a new pack.
  expect(await buildSetPack({ ...set, name: 'Another Name' }, manifest, false, first)).toBe(true);
  expect(manifest['(pack)']).not.toBe(committed);
});
