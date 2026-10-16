import type { CutPoint } from '../../hooks/usePackCutter';

/** One stretch of the drawn seam, as SVG polyline points, and how strongly it shows. */
export interface SeamBand {
  points: string;
  opacity: number;
}

/** How faint the oldest stretch of the seam gets. */
const OLDEST_OPACITY = 0.35;

/**
 * Splits the drawn cut into up to `maxBands` stretches in the order they were cut, faintest first,
 * so the seam fades out behind the finger whichever way it swipes, even over and back (#267). Each
 * stretch shares its end point with the next, so the seam has no gaps.
 */
export const seamBands = (points: readonly CutPoint[], maxBands = 4): SeamBand[] => {
  if (points.length < 2) return [];
  const segments = points.length - 1;
  const bands = Math.min(Math.max(1, Math.floor(maxBands)), segments);
  return Array.from({ length: bands }, (_, band) => {
    const from = Math.floor((band * segments) / bands);
    const to = Math.floor(((band + 1) * segments) / bands);
    return {
      points: points.slice(from, to + 1).map((point) => `${point.x},${point.y}`).join(' '),
      opacity: bands === 1 ? 1 : OLDEST_OPACITY + ((1 - OLDEST_OPACITY) * band) / (bands - 1),
    };
  });
};
