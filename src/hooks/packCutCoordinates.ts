import type { CutPoint } from './usePackCutter';

/** Convert the SVG viewBox point into pixels in the same, untransformed pack. */
export function cutPointInPixels(point: CutPoint, layout: Pick<HTMLElement, 'clientWidth' | 'clientHeight'>): CutPoint {
  return { x: point.x * layout.clientWidth / 100, y: point.y * layout.clientHeight / 100 };
}
