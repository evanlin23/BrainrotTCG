// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS, CARD_RARITIES, cardNumber } from '../data/cards';
import { SETS, setCode } from '../content/sets';
import { MAX_NAME_LENGTH, isValidName, normalizeName } from '../engine';
import { FINISH_INFO, modifierLabel } from './modifiers';
import { planQr } from './qrCode';
import { ellipsize, fitLabelText, fitRarityLines, renderCardPoster, renderPoster, wrapParts, type CardPosterInput } from './bragImage';

// Finishing card art needs real pixels; this suite is about text, so the art passes through untouched.
vi.mock('./finishImage', () => ({ holdFinishedCardImage: (src: string) => ({ image: Promise.resolve(src), release: () => undefined }) }));

/**
 * A text width model with real proportions rather than one width for every string: letters, digits,
 * stars, CJK and astral math letters all differ, and widths scale with the font size in ctx.font.
 * Calibrated on the measurements in the issues: the 24-letter fraktur name is 744px at 20px, and the
 * Strawberry Elephant lines are 611px (plain), 810px (Platinum) and 1,115px (Platinum + Holo + Misprint) at 40px.
 */
const K = 0.8525;
const em = (ch: string): number => {
  const cp = ch.codePointAt(0)!;
  if (cp > 0xffff) return 1.55;
  if (cp >= 0x2e80 && cp <= 0x9fff) return 1;
  if (cp === 0x2605 || cp === 0x25cf || cp === 0x25c6 || cp === 0x2726) return K;
  if (ch === ' ') return 0.28 * K;
  if (ch === '·' || ch === '…') return 0.4 * K;
  if (/[A-Z0-9/]/.test(ch)) return 0.72 * K;
  return 0.58 * K;
};
const widthAt = (text: string, size: number) => Array.from(text).reduce((sum, ch) => sum + em(ch), 0) * size;
const sizeOf = (font: string) => parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)![1]);

interface Drawn {
  text: string;
  x: number;
  y: number;
  size: number;
  align: string;
  maxWidth?: number;
  /** Unsqueezed advance width at the font in force when it was drawn. */
  width: number;
}

const fakeCanvas = () => {
  const drawn: Drawn[] = [];
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const ctx = {
    font: '',
    textAlign: 'left',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    shadowColor: '',
    measureText: (text: string) => ({ width: widthAt(text, sizeOf(ctx.font)) }),
    fillText: (text: string, x: number, y: number, maxWidth?: number) => {
      const size = sizeOf(ctx.font);
      drawn.push({ text, x, y, size, align: ctx.textAlign, maxWidth, width: widthAt(text, size) });
    },
    roundRect: (x: number, y: number, w: number, h: number) => rects.push({ x, y, w, h }),
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: vi.fn(),
    fillRect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clip: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn, rects };
};

/** Left and right edge of a drawn string, as the canvas would place it. */
const extent = (d: Drawn) => {
  const left = d.align === 'center' ? d.x - d.width / 2 : d.align === 'right' ? d.x - d.width : d.x;
  return { left, right: left + d.width };
};

const URL = 'https://evanlin23.github.io/BrainrotTCG/#/pull/test-share-link';
const NAME_BASELINE = 1570 + 134;

describe('poster text fitting', () => {
  let canvas: ReturnType<typeof fakeCanvas>;

  beforeEach(() => {
    canvas = fakeCanvas();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => canvas.ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 687;
        naturalHeight = 1024;
        set src(_: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  // --- the longest valid inputs, derived from the real sets and the real name rules ---

  const finishes = [null, ...(Object.keys(FINISH_INFO) as (keyof typeof FINISH_INFO)[])];
  const rarityParts = (card: (typeof ALL_CARDS)[number], finish: (typeof finishes)[number], isHolo: boolean, misprint: boolean) => {
    const set = SETS.find((s) => s.id === card.setId)!;
    const mods = modifierLabel({ finish, isHolo, misprint });
    const rarity = CARD_RARITIES[card.rarity];
    return [`${rarity.symbol} ${rarity.name}`, ...(mods ? mods.split(' · ') : []), `${setCode(set)} ${cardNumber(card)}`];
  };
  const everyLabel = ALL_CARDS.flatMap((card) =>
    finishes.flatMap((finish) =>
      [false, true].flatMap((isHolo) =>
        [false, true].map((misprint) => ({ card, finish, isHolo, misprint, parts: rarityParts(card, finish, isHolo, misprint) })),
      ),
    ),
  );
  const lineWidth = (parts: string[]) => widthAt(parts.join(' · '), 40);
  const longest = everyLabel.reduce((a, b) => (lineWidth(b.parts) > lineWidth(a.parts) ? b : a));
  const wideName = '\u{1D582}'.repeat(MAX_NAME_LENGTH);

  it('measures like the real font on the issue\'s controls', () => {
    const line = (...mods: string[]) => widthAt(['\u2605\u2605\u2605 Legendary', ...mods, 'IBDC 011/012'].join(' \u00b7 '), 40);
    expect(Math.abs(line() / 611 - 1)).toBeLessThan(0.02);
    expect(Math.abs(line('Platinum') / 810 - 1)).toBeLessThan(0.02);
    expect(Math.abs(line('Platinum', 'Holo', 'Misprint') / 1115 - 1)).toBeLessThan(0.02);
    expect(Math.abs(widthAt(wideName, 20) / 744 - 1)).toBeLessThan(0.02);
  });

  it('uses real limits: the longest label is Legendary with every modifier, and the wide name is valid', () => {
    expect(longest.parts.slice(0, 4)).toEqual(['★★★ Legendary', 'Platinum', 'Holo', 'Misprint']);
    // In the real font this is 1,115px at 40px (issue #661), past the 960px content width; the model agrees it overflows.
    expect(lineWidth(longest.parts)).toBeGreaterThan(1080 - 120);
    expect(isValidName(wideName)).toBe(true);
    expect(normalizeName(wideName)).toBe(wideName);
  });

  const cardInput = (over: Partial<CardPosterInput['card']> = {}, url: string | undefined = URL): CardPosterInput => {
    const rarity = CARD_RARITIES[longest.card.rarity];
    const set = SETS.find((s) => s.id === longest.card.setId)!;
    return {
      card: {
        image: 'x.webp',
        name: longest.card.name,
        isHolo: longest.isHolo,
        finish: longest.finish,
        misprint: longest.misprint,
        rarityName: rarity.name,
        raritySymbol: rarity.symbol,
        rarityColor: '#fff',
        number: cardNumber(longest.card),
        ...over,
      },
      setName: set.name,
      setCode: setCode(set),
      playerName: 'Poster QA',
      fingerprint: 'abcd1234efgh5678',
      url,
    };
  };

  describe('rarity, modifier and collector line (#661)', () => {
    const rarityDraws = () => canvas.drawn.filter((d) => /Legendary|Platinum|Misprint|Holo|Common/.test(d.text) || d.text.includes(longest.parts[longest.parts.length - 1]));

    it('keeps every part of the longest combination inside the content margins', async () => {
      await renderCardPoster(cardInput());
      const draws = rarityDraws();
      expect(draws.length).toBeGreaterThan(0);
      for (const d of draws) {
        const { left, right } = extent(d);
        expect(left).toBeGreaterThanOrEqual(60);
        expect(right).toBeLessThanOrEqual(1080 - 60);
        expect(d.size).toBeGreaterThanOrEqual(34);
      }
      // Nothing dropped: the complete label, stars to the end of the collector number, across the lines.
      expect(draws.map((d) => d.text).join(' · ')).toBe(longest.parts.join(' · '));
    });

    it('keeps plain and one-modifier controls on one 40px line', async () => {
      for (const over of [
        { finish: null, isHolo: false, misprint: false },
        { finish: 'PLATINUM' as const, isHolo: false, misprint: false },
      ]) {
        canvas.drawn.length = 0;
        await renderCardPoster(cardInput(over));
        const lines = rarityDraws();
        expect(lines).toHaveLength(1);
        expect(lines[0].size).toBe(40);
        const { left, right } = extent(lines[0]);
        expect(right - left).toBeLessThanOrEqual(960);
      }
    });

    it('fitRarityLines shrinks first, then wraps between parts without dropping any', () => {
      const fits = fitRarityLines(canvas.ctx, ['● Common', 'IBDC 001/012'], 960);
      expect(fits).toEqual(['● Common · IBDC 001/012']);
      expect(canvas.ctx.font).toContain('40px');

      const shrunk = fitRarityLines(canvas.ctx, longest.parts, 960);
      expect(shrunk).toEqual([longest.parts.join(' · ')]);
      expect(sizeOf(canvas.ctx.font)).toBeLessThan(40);
      expect(sizeOf(canvas.ctx.font)).toBeGreaterThanOrEqual(34);

      // Too long even at the 34px floor: wraps at part boundaries at 36px.
      const parts = [...longest.parts.slice(0, -1), 'an extra part that is far too long to share a line', longest.parts[longest.parts.length - 1]];
      const lines = fitRarityLines(canvas.ctx, parts, 960);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.join(' · ')).toBe(parts.join(' · '));
      expect(sizeOf(canvas.ctx.font)).toBe(36);
      for (const line of lines) expect(canvas.ctx.measureText(line).width).toBeLessThanOrEqual(960);
    });
  });

  describe('player name beside the QR code (#692)', () => {
    const qrSide = async () => (await planQr(URL))!.side;
    const nameDraw = () => canvas.drawn.find((d) => d.y === NAME_BASELINE)!;

    it('stops the 24-code-point wide name short of the QR code, abbreviating only what is drawn', async () => {
      const side = await qrSide();
      await renderCardPoster({ ...cardInput(), playerName: wideName });
      const qr = canvas.rects.find((r) => r.w === side && r.h === side)!;
      expect(qr).toBeDefined();
      const name = nameDraw();
      expect(extent(name).right).toBeLessThanOrEqual(qr.x);
      expect(name.text.endsWith('…')).toBe(true);
      expect(wideName.startsWith(name.text.slice(0, -1))).toBe(true);
      expect(name.text).toBe(Array.from(name.text).join(''));
      expect(name.size).toBe(20);
    });

    it('draws the whole wide name when there is no QR code to clear', async () => {
      await renderCardPoster({ ...cardInput(), url: undefined, playerName: wideName });
      const name = nameDraw();
      expect(name.text).toBe(wideName);
      expect(extent(name).right).toBeLessThanOrEqual(70 + 940 - 40);
    });

    it('keeps the pack poster label clear of its QR code too', async () => {
      const side = await qrSide();
      const card = { image: 'x.webp', name: 'Card', isHolo: false };
      await renderPoster({
        cards: [card, card, card, card, card],
        score: { score: 1000, hand: { name: 'Full House', multiplier: 10 }, points: 100 },
        setName: 'Genesis',
        playerName: wideName,
        fingerprint: '1234567812345678',
        url: URL,
      });
      const qr = canvas.rects.find((r) => r.w === side && r.h === side)!;
      expect(extent(nameDraw()).right).toBeLessThanOrEqual(qr.x);
    });

    it.each([
      ['ordinary', 'Poster QA'],
      ['CJK', '漢字'.repeat(12)],
      ['Arabic', 'مرحبا بالعالم'],
      ['Hebrew', 'שלום עולם'],
      ['astral boundary', `${'a'.repeat(23)}\u{1D582}`],
      ['mixed script', 'Ana 漢字 \u{10400}\u{10401} Z'],
    ])('keeps a %s name inside its slot, whole when it fits', async (_label, playerName) => {
      expect(isValidName(playerName)).toBe(true);
      const side = await qrSide();
      await renderCardPoster({ ...cardInput(), playerName });
      const qr = canvas.rects.find((r) => r.w === side && r.h === side)!;
      const name = nameDraw();
      expect(extent(name).right).toBeLessThanOrEqual(qr.x);
      if (widthAt(playerName, 20) <= qr.x - 24 - 110) expect(name.text).toBe(playerName);
    });
  });

  describe('helpers', () => {
    it('ellipsize returns fitting text unchanged and cuts at user-perceived characters', () => {
      canvas.ctx.font = '800 20px x';
      expect(ellipsize(canvas.ctx, 'short', 500)).toBe('short');
      const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
      const cut = ellipsize(canvas.ctx, family.repeat(10), 150);
      expect(cut.endsWith('…')).toBe(true);
      expect(cut.slice(0, -1).split(family).join('')).toBe('');
      expect(canvas.ctx.measureText(cut).width).toBeLessThanOrEqual(150);
    });

    it('ellipsize without Intl.Segmenter still never cuts a surrogate pair', () => {
      vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
      canvas.ctx.font = '800 20px x';
      const cut = ellipsize(canvas.ctx, '\u{1F600}'.repeat(30), 150);
      expect(cut.endsWith('…')).toBe(true);
      expect(cut.slice(0, -1).split('\u{1F600}').join('')).toBe('');
      expect(canvas.ctx.measureText(cut).width).toBeLessThanOrEqual(150);
    });

    it('ellipsize degrades to a bare ellipsis when nothing else fits', () => {
      canvas.ctx.font = '800 20px x';
      expect(ellipsize(canvas.ctx, 'wide wide', 1)).toBe('…');
    });

    it('fitLabelText shrinks to the floor before abbreviating', () => {
      const text = 'W'.repeat(10);
      expect(fitLabelText(canvas.ctx, text, 300, 52, '800', 'x')).toBe(text);
      expect(sizeOf(canvas.ctx.font)).toBeLessThan(52);
      const cut = fitLabelText(canvas.ctx, text, 100, 52, '800', 'x');
      expect(sizeOf(canvas.ctx.font)).toBe(20);
      expect(cut.endsWith('…')).toBe(true);
    });

    it('wrapParts keeps every part in order', () => {
      canvas.ctx.font = '700 20px x';
      const lines = wrapParts(canvas.ctx, ['aaaa', 'bbbb', 'cccc'], 100);
      expect(lines.join(' · ')).toBe('aaaa · bbbb · cccc');
      expect(lines.length).toBeGreaterThan(1);
    });
  });
});
