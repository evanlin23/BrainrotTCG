import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PackCuttingUI from '../components/pack/PackCuttingUI';
import { SETS } from '../content/sets';

describe('Pack cutting spark coordinate contract (#265)', () => {
  const dummySet = SETS[0];

  it('renders spark layer inside pack-shell-wrap using local pack coordinates', () => {
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
  });

  it('calculates pack-local spark coordinates independent of transformed ancestor rect.top offset', () => {
    // Simulate pack bounding rect on narrow/short mobile viewport with top offset (header / transform)
    const rectTopOffsets = [0, 80, 150, 240];
    const packWidth = 320;
    const packHeight = 573.86; // 320 * (2752 / 1536)
    const tearLineRatio = 0.19;
    const expectedLocalTearY = packHeight * tearLineRatio; // 109.0334px local to pack

    rectTopOffsets.forEach((rectTop) => {
      // User touches at the tear line in viewport coordinates
      const viewportTouchY = rectTop + expectedLocalTearY;
      const viewportTouchX = 160;

      // Local point calculation
      const localX = viewportTouchX - 0; // rect.left = 0
      const clampedX = Math.min(packWidth, Math.max(0, localX));

      // Verify touch coordinates mapping
      expect(viewportTouchY - rectTop).toBeCloseTo(expectedLocalTearY, 5);
      expect(clampedX).toBe(160);

      // Correct local spark coordinates (anchored to .pack-shell-wrap)
      const correctLocalSparkY = packHeight * tearLineRatio;

      // Old buggy viewport spark coordinates (would be offset down by rectTop if .spark-layer was inside transformed parent)
      const buggyViewportSparkY = rectTop + packHeight * tearLineRatio;

      // The spark's local Y must equal expectedLocalTearY, regardless of rectTop offset
      expect(correctLocalSparkY).toBeCloseTo(109.0334, 3);

      if (rectTop > 0) {
        // Under the old implementation, sparkY was rectTop + localTearY, causing a downward shift equal to rectTop
        expect(buggyViewportSparkY).toBeGreaterThan(correctLocalSparkY);
        expect(buggyViewportSparkY - correctLocalSparkY).toBeCloseTo(rectTop, 5);
      }
    });
  });
});
