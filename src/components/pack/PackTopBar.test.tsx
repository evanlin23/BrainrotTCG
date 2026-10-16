import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ALL_CARDS } from '../../data/cards';
import PackTopBar from './PackTopBar';
import ShowcaseRibbon from './ShowcaseRibbon';

const closeButton = (html: string) => html.match(/<button[^>]*aria-label="Back to packs"[^>]*>/)?.[0];

describe('pack top bar', () => {
  it('is an icon button named Back to packs that is never disabled', () => {
    const html = renderToStaticMarkup(<PackTopBar onLeave={() => {}} />);
    expect(closeButton(html)).toContain('class="icon-btn pack-close"');
    expect(closeButton(html)).not.toContain('disabled');
    expect(html).not.toContain('role="progressbar"');
  });

  it('shows the card count during the reveal', () => {
    const html = renderToStaticMarkup(<PackTopBar onLeave={() => {}} progress={{ index: 1, total: 5 }} />);
    expect(closeButton(html)).toBeDefined();
    expect(html).toContain('>Card 2 of 5</span>');
    expect(html).toContain('aria-valuetext="Card 2 of 5"');
    expect(html.match(/<span class="done"/g)).toHaveLength(1);
    expect(html.match(/<span class="current"/g)).toHaveLength(1);
  });

  it('puts a big pull\'s ribbon in the progress\'s place, above the card, keeping the X', () => {
    const html = renderToStaticMarkup(
      <PackTopBar
        onLeave={() => {}}
        progress={{ index: 4, total: 5 }}
        showcase={<ShowcaseRibbon card={{ ...ALL_CARDS[0], rarity: 'COMMON', uniqueId: 1, isRevealed: true, isHolo: false, finish: 'DIAMOND' }} />}
      />,
    );
    expect(closeButton(html)).toBeDefined();
    // One announcement of the pull, with its points.
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toMatch(/<div class="showcase-ribbon" role="status"[^>]*><span class="showcase-ribbon-kicker">Big pull!<\/span><strong[^>]*>10,000 points<\/strong><\/div>/);
    expect(html).not.toContain('Card 5 of 5');
    expect(html).not.toContain('role="progressbar"');
  });
});
