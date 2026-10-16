import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RarityBadge from './RarityBadge';

/** The badge's visible text, as a screen reader reads it. */
const text = (props: Record<string, unknown>) =>
  renderToStaticMarkup(<RarityBadge rarity="COMMON" {...props} />).replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");

describe('RarityBadge', () => {
  it('names the flags and scores them', () => {
    expect(text({ isHolo: true, misprint: true })).toContain('Holo Misprint Common');
    expect(text({ isHolo: true, misprint: true })).toContain(`${(10 * 20 * 200).toLocaleString()} pts`);
    expect(text({})).toMatch(/^.Common10 pts$/u);
  });

  // An older stored card can carry a non-boolean flag: read it as `!!flag`, never print it.
  it.each([0, Number.NaN, '', null])('reads a stored %s flag as not set', (value) => {
    expect(text({ isHolo: value, misprint: value })).toMatch(/^.Common10 pts$/u);
  });

  it('reads a truthy non-boolean flag as set', () => {
    expect(text({ isHolo: 1 })).toContain('Holo Common');
    expect(text({ isHolo: 1 })).toContain('200 pts');
  });
});
