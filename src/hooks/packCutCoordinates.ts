import type { CutPoint } from './usePackCutter';

/** The pack on screen (getBoundingClientRect): after every ancestor scale, rotate or translate. */
export type PackRect = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>;
/** The pack's own layout size (clientWidth/clientHeight): what the SVG viewBox and the spark layer span. */
export type PackLayout = Pick<HTMLElement, 'clientWidth' | 'clientHeight'>;

export interface PackPointer {
  /** Pointer position inside the bounding box, in screen pixels. */
  x: number;
  y: number;
  /** The bounding box size. The hit test and the completion span are measured against it. */
  width: number;
  height: number;
  /** x clamped to the bounding box. */
  clampedX: number;
  /** The cut point in SVG viewBox percent, pinned to the cut line. */
  cut: CutPoint;
  /** The same point in layout pixels, where the spark layer draws it. */
  spark: CutPoint;
}

/**
 * Convert an SVG viewBox point into pixels in the same, untransformed pack.
 * clientWidth/clientHeight are rounded to whole pixels, so on a fractional layout size the result
 * sits up to 0.5px from the SVG point (the percent is at most 100%).
 */
export function cutPointInPixels(point: CutPoint, layout: PackLayout): CutPoint {
  return { x: point.x * layout.clientWidth / 100, y: point.y * layout.clientHeight / 100 };
}

/**
 * Map a pointer to the cut it draws. The percent comes from the bounding box, so it follows the
 * pointer under any ancestor scale. The spark pixels use the layout size instead: the spark layer
 * lives inside the pack, so the ancestor transforms apply to it as they do to the SVG, and sizing it
 * from the bounding box would apply them twice. Under a rotated ancestor the bounding box is wider
 * than the pack, so x is only approximate there (a known limit).
 */
export function mapPackPointer(
  clientX: number,
  clientY: number,
  rect: PackRect,
  layout: PackLayout,
  cutLineRatio: number,
): PackPointer {
  const x = clientX - rect.left;
  const clampedX = Math.min(rect.width, Math.max(0, x));
  const cut = { x: (clampedX / rect.width) * 100, y: cutLineRatio * 100 };
  return {
    x,
    y: clientY - rect.top,
    width: rect.width,
    height: rect.height,
    clampedX,
    cut,
    spark: cutPointInPixels(cut, layout),
  };
}
