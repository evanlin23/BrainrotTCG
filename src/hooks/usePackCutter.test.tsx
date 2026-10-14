import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PackCuttingUI from '../components/pack/PackCuttingUI';
import { SETS } from '../content/sets';
import { cutPointInPixels } from './packCutCoordinates';

describe('Pack cutting spark coordinate contract (#265)', () => {
  const dummySet = SETS[0];

  it('renders spark pixels in the same pack as the percentage cut line', () => {
    const localSparkX = 120; // 120px from left of pack
    const localSparkY = 102.125; // 19% of a 537.5px height pack (exact tear line local position)

    const html = renderToStaticMarkup(
      <PackCuttingUI
        packRef={{ current: null }}
        packDesign="/test-design.webp"
        set={dummySet}
        error={null}
        isCutting={true}
        isPackCut={false}
        cutPoints={[{ x: 40, y: 19 }, { x: 60, y: 19 }]}
        sparks={[
          {
            id: 1,
            x: localSparkX,
            y: localSparkY,
            dx: 12,
            dy: -20,
            size: 10,
            hue: 40,
          },
        ]}
      />
    );

    // Verify spark-layer is rendered with local pixel coordinates
    expect(html).toContain('class="spark-layer"');
    expect(html).toContain('class="drag-spark"');
    expect(html).toContain(`--x:${localSparkX}px`);
    expect(html).toContain(`--y:${localSparkY}px`);
    // Both layers are children of the pack, before the pack and wrapper close.
    expect(html.endsWith('</span></div></div></div>')).toBe(true);
  });

  it.each([
    { clientWidth: 320, clientHeight: 574 },
    { clientWidth: 390, clientHeight: 699 },
    { clientWidth: 800, clientHeight: 1433 },
  ])('maps the SVG endpoint to layout pixels for $clientWidth px packs', (layout) => {
    const endpoint = { x: 60, y: 19 };
    expect(cutPointInPixels(endpoint, layout)).toEqual({
      x: layout.clientWidth * 0.6,
      y: layout.clientHeight * 0.19,
    });
  });

  it('uses layout dimensions even when a rotated ancestor enlarges the viewport bounds', () => {
    const rotatedPack = {
      clientWidth: 320,
      clientHeight: 574,
      getBoundingClientRect: () => ({ width: 414.8125, height: 620.671875, top: 87.6875 }),
    };
    expect(cutPointInPixels({ x: 60, y: 19 }, rotatedPack)).toEqual({ x: 192, y: 109.06 });
  });
});
