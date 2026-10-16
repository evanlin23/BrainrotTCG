import { afterEach, expect, it, vi } from 'vitest';
import { LOGO_MARK_PATH } from '../styles/logoMark';
import { BRAND, PAPER } from '../styles/palette';
import { drawLogo } from './bragImage';

const TEXT_WIDTH = 700;

/** Records what drawLogo draws: each fill and fillText with the colour and translation at the time. */
const fakeContext = () => {
  const drawn: { kind: 'mark' | 'text'; colour: string; x: number; y: number; d?: string }[] = [];
  let at = { x: 0, y: 0 };
  const ctx = {
    font: '',
    textAlign: 'center',
    fillStyle: '',
    measureText: () => ({ width: TEXT_WIDTH }),
    save: () => undefined,
    restore: () => (at = { x: 0, y: 0 }),
    translate: (x: number, y: number) => (at = { x, y }),
    scale: () => undefined,
    fill: (path: { d: string }) => drawn.push({ kind: 'mark', colour: ctx.fillStyle, ...at, d: path.d }),
    fillText: (text: string, x: number, y: number) => {
      expect(text).toBe('BRAINROT TCG');
      drawn.push({ kind: 'text', colour: ctx.fillStyle, x, y });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
};

afterEach(() => vi.unstubAllGlobals());

it('draws the mark beside the wordmark, both with the misprint offset, centred together', () => {
  vi.stubGlobal('Path2D', class { constructor(readonly d: string) {} });
  const { ctx, drawn } = fakeContext();
  drawLogo(ctx, 160);

  expect(drawn.map(({ kind, colour }) => [kind, colour])).toEqual([
    ['mark', BRAND],
    ['text', BRAND],
    ['mark', PAPER],
    ['text', PAPER],
  ]);
  const [, , mark, text] = drawn;
  expect(mark.d).toBe(LOGO_MARK_PATH);
  // The yellow copies sit 8px down and right of the white ones.
  expect([drawn[0].x - mark.x, drawn[0].y - mark.y, drawn[1].x - text.x, drawn[1].y - text.y]).toEqual([8, 8, 8, 8]);
  // Mark, then the wordmark after it, with equal margins either side of the pair.
  expect(text.x).toBeGreaterThan(mark.x);
  expect(text.y).toBe(160);
  expect(mark.x).toBeCloseTo(1080 - (text.x + TEXT_WIDTH));
});

it('draws the wordmark alone, centred, where there is no Path2D', () => {
  vi.stubGlobal('Path2D', undefined);
  const { ctx, drawn } = fakeContext();
  drawLogo(ctx, 160);

  expect(drawn.map(({ kind, colour, x, y }) => [kind, colour, x, y])).toEqual([
    ['text', BRAND, 198, 168],
    ['text', PAPER, 190, 160],
  ]);
});
