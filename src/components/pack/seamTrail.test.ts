import { describe, expect, it } from 'vitest';
import { seamBands } from './seamTrail';

const line = (...xs: number[]) => xs.map((x) => ({ x, y: 19 }));

describe('seamBands (#267)', () => {
  it('draws nothing for fewer than two points', () => {
    expect(seamBands([])).toEqual([]);
    expect(seamBands(line(40))).toEqual([]);
  });

  it('draws two points as one full-strength stretch', () => {
    expect(seamBands(line(40, 60))).toEqual([{ points: '40,19 60,19', opacity: 1 }]);
  });

  it('fades the oldest stretch most, so the seam fades behind the finger', () => {
    const bands = seamBands(line(10, 20, 30, 40, 50, 60, 70, 80, 90));
    expect(bands.map((band) => band.points)).toEqual([
      '10,19 20,19 30,19',
      '30,19 40,19 50,19',
      '50,19 60,19 70,19',
      '70,19 80,19 90,19',
    ]);
    const opacities = bands.map((band) => band.opacity);
    expect(opacities[0]).toBeCloseTo(0.35);
    expect(opacities[3]).toBe(1);
    for (let i = 1; i < opacities.length; i++) expect(opacities[i]).toBeGreaterThan(opacities[i - 1]);
  });

  it('follows the order points were cut, not where they are, so a swipe back fades its way out', () => {
    // Over to 70 and back to 30: the newest stretch is the way back.
    const bands = seamBands(line(30, 50, 70, 50, 30));
    expect(bands[bands.length - 1]).toEqual({ points: '50,19 30,19', opacity: 1 });
    expect(bands[0].points).toBe('30,19 50,19');
  });

  it('keeps every point in some stretch, with no gap between stretches', () => {
    const points = line(...Array.from({ length: 23 }, (_, i) => i * 4));
    const bands = seamBands(points);
    expect(bands).toHaveLength(4);
    const ends = bands.map((band) => band.points.split(' '));
    expect(ends[0][0]).toBe('0,19');
    const last = ends[ends.length - 1];
    expect(last[last.length - 1]).toBe('88,19');
    for (let i = 1; i < ends.length; i++) expect(ends[i][0]).toBe(ends[i - 1][ends[i - 1].length - 1]);
    expect(new Set(ends.flat()).size).toBe(points.length);
  });

  it('uses fewer stretches when there are fewer segments', () => {
    expect(seamBands(line(10, 20, 30))).toHaveLength(2);
  });
});
