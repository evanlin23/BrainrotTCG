import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PackCuttingUI from '../components/pack/PackCuttingUI';
import { SETS } from '../content/sets';
import { cutPointInPixels, mapPackPointer, type PackLayout, type PackRect } from './packCutCoordinates';
import { usePackCutter } from './usePackCutter';

const TEAR = 0.19;
// A 320px-wide pack laid out at 1536:2752, so its height is 573.33px and clientHeight rounds it.
const layout: PackLayout = { clientWidth: 320, clientHeight: 573 };
const tearPx = TEAR * layout.clientHeight;

// An ancestor scale(1.25), with the pack 100px right and 50px down the viewport.
const scaledRect: PackRect = { left: 100, top: 50, width: 400, height: 716.25 };

// An ancestor rotate(-10deg) about the pack's centre: its bounding box grows past the pack.
const rotatedRect = (() => {
  const rad = (10 * Math.PI) / 180;
  const width = layout.clientWidth * Math.cos(rad) + layout.clientHeight * Math.sin(rad);
  const height = layout.clientWidth * Math.sin(rad) + layout.clientHeight * Math.cos(rad);
  return { left: 500 - width / 2, top: 400 - height / 2, width, height };
})();

describe('mapPackPointer (#265)', () => {
  it('takes the percent from the scaled bounding box and the spark pixels from the layout size', () => {
    const point = mapPackPointer(100 + 240, 50 + 0.19 * 716.25, scaledRect, layout, TEAR);
    expect(point.x).toBeCloseTo(240);
    expect(point.y).toBeCloseTo(136.0875);
    expect(point.width).toBe(400);
    expect(point.clampedX).toBeCloseTo(240);
    expect(point.cut.x).toBeCloseTo(60);
    expect(point.cut.y).toBeCloseTo(19);
    // Bounding-box sizing would put it at (240, 136.09), and the old viewport sparks at (340, 186.09).
    expect(point.spark.x).toBeCloseTo(192);
    expect(point.spark.y).toBeCloseTo(tearPx);
  });

  it('keeps the spark on the pack, not the larger box, under a rotated ancestor', () => {
    const centreX = rotatedRect.left + rotatedRect.width / 2;
    const point = mapPackPointer(centreX, rotatedRect.top + TEAR * rotatedRect.height, rotatedRect, layout, TEAR);
    expect(point.cut.x).toBeCloseTo(50);
    // Bounding-box sizing would give (207.3, 117.8): off the pack's centre and below its tear line.
    expect(point.spark.x).toBeCloseTo(layout.clientWidth / 2);
    expect(point.spark.y).toBeCloseTo(tearPx);
  });

  it('clamps a pointer past either edge to the edge', () => {
    const left = mapPackPointer(scaledRect.left - 30, 186, scaledRect, layout, TEAR);
    expect([left.x, left.clampedX, left.cut.x, left.spark.x]).toEqual([-30, 0, 0, 0]);
    const right = mapPackPointer(scaledRect.left + 430, 186, scaledRect, layout, TEAR);
    expect([right.clampedX, right.cut.x, right.spark.x]).toEqual([400, 100, 320]);
  });

  it('stays within 0.5px of the SVG when the layout size is fractional', () => {
    // A 390.4px-wide pack is 699.47px tall: clientWidth/clientHeight round both to whole pixels,
    // and the SVG point is a percent of the fractional size, so the spark can be off by up to 0.5px.
    const width = 390.4;
    const height = (width * 2752) / 1536;
    const rect = { left: 0, top: 0, width, height };
    const rounded = { clientWidth: Math.round(width), clientHeight: Math.round(height) };
    for (let clientX = 0; clientX <= width; clientX += width / 8) {
      const point = mapPackPointer(clientX, TEAR * height, rect, rounded, TEAR);
      expect(Math.abs(point.spark.x - (point.cut.x / 100) * width)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(point.spark.y - (point.cut.y / 100) * height)).toBeLessThanOrEqual(0.5);
    }
  });

  it.each([
    { clientWidth: 320, clientHeight: 573 },
    { clientWidth: 390, clientHeight: 699 },
    { clientWidth: 800, clientHeight: 1433 },
  ])('maps the SVG endpoint to layout pixels for $clientWidth px packs', (size) => {
    expect(cutPointInPixels({ x: 60, y: 19 }, size)).toEqual({
      x: size.clientWidth * 0.6,
      y: size.clientHeight * 0.19,
    });
  });
});

describe('usePackCutter sparks (#265)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis); // emitSpark schedules removal with window.setTimeout
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no spark jitter
    // A stroke draws at the next frame; there are no frames here, so draw at once.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * Swipe 20px along the pack to a point and return where the pack drew its sparks. There's no DOM
   * here, so the probe hands the hook a measured pack and swipes it while rendering; the server
   * renderer re-renders on those state updates until the cut has started. Sparks start where the
   * swipe has gone across, not at the press (#267).
   */
  const pressPack = (rect: PackRect, clientX: number, clientY: number) => {
    const pack = { clientWidth: layout.clientWidth, clientHeight: layout.clientHeight, getBoundingClientRect: () => rect };
    const Probe = () => {
      const cutter = usePackCutter({ onCutComplete: () => {}, isOpening: false, isPackCut: false, volume: 0 });
      // Test probe: no DOM to attach the ref to.
      cutter.packRef.current = pack as unknown as HTMLDivElement;
      if (!cutter.isCutting) {
        const finger = { button: 0, pointerId: 1, pointerType: 'touch', isPrimary: true, clientY, target: null };
        cutter.handlePointerDown({ ...finger, clientX: clientX - 20 } as unknown as PointerEvent);
        cutter.handlePointerMove({ ...finger, clientX } as unknown as PointerEvent);
      }
      return (
        <PackCuttingUI packRef={cutter.packRef} packDesign="/test-design.webp" set={SETS[0]} error={null}
          isCutting={cutter.isCutting} isPackCut={false} cutPoints={cutter.cutPoints} sparks={cutter.sparks} />
      );
    };
    const html = renderToStaticMarkup(<Probe />);
    return [...html.matchAll(/--x:([-\d.e]+)px;--y:([-\d.e]+)px/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  };

  it('emits sparks in layout pixels inside a scaled, translated pack', () => {
    const sparks = pressPack(scaledRect, 100 + 240, 50 + 0.19 * 716.25);
    expect(sparks).toHaveLength(3);
    for (const spark of sparks) {
      expect(spark.x).toBeCloseTo(192);
      expect(spark.y).toBeCloseTo(tearPx);
    }
  });

  it('emits sparks on the pack under a rotated ancestor', () => {
    const centreX = rotatedRect.left + rotatedRect.width / 2;
    const sparks = pressPack(rotatedRect, centreX, rotatedRect.top + TEAR * rotatedRect.height);
    expect(sparks).toHaveLength(3);
    expect(sparks[0].x).toBeCloseTo(layout.clientWidth / 2);
    expect(sparks[0].y).toBeCloseTo(tearPx);
  });
});

describe('PackCuttingUI spark layer (#265)', () => {
  it('renders spark pixels in the same pack as the percentage cut line', () => {
    const html = renderToStaticMarkup(
      <PackCuttingUI
        packRef={{ current: null }}
        packDesign="/test-design.webp"
        set={SETS[0]}
        error={null}
        isCutting={true}
        isPackCut={false}
        cutPoints={[{ x: 40, y: 19 }, { x: 60, y: 19 }]}
        sparks={[{ id: 1, x: 192, y: 108.87, dx: 12, dy: -20, size: 10, hue: 40 }]}
      />
    );

    expect(html).toContain('class="spark-layer"');
    expect(html).toContain('class="drag-spark"');
    expect(html).toContain('--x:192px');
    expect(html).toContain('--y:108.87px');
    // Both layers are children of the pack, before the pack and wrapper close.
    expect(html.endsWith('</span></div></div></div>')).toBe(true);
  });
});
