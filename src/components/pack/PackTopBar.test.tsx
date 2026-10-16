import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PackTopBar from './PackTopBar';

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
});
