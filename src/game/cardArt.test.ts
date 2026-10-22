// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ALL_CARDS } from '../data/cards';
import { BLANK_CARD_ART, isApprovedCardArt } from './cardArt';

const origin = window.location.origin;

describe('which card art may be requested', () => {
  it('always allows the art the catalog ships, whatever address the bundler gave it', () => {
    for (const card of ALL_CARDS) expect(isApprovedCardArt(card.image), card.key).toBe(true);
  });

  it.each([
    '/old.webp',
    '/BrainrotTCG/assets/amogus-1a2b3c.webp',
    'images/old.webp',
    './old.webp',
    '../old.webp',
    `${origin}/BrainrotTCG/assets/old.webp`,
    '/old.webp?v=2#frame',
  ])('allows archived art on this site: %s', (image) => {
    expect(isApprovedCardArt(image)).toBe(true);
  });

  it.each([
    ['another host', 'https://tracker.example/pixel.gif?id=1'],
    ['plain http on another host', 'http://tracker.example/pixel.gif'],
    ['a protocol-relative address', '//tracker.example/pixel.gif'],
    ['a backslash protocol-relative address', '/\\tracker.example/pixel.gif'],
    ['a double-backslash address', '\\\\tracker.example\\pixel.gif'],
    ['a protocol-relative address broken up by a tab', '/\t/tracker.example/pixel.gif'],
    ['a protocol-relative address with a leading space', ' //tracker.example/pixel.gif'],
    ['a look-alike host', `${origin}.tracker.example/pixel.gif`],
    ['this origin written as the credentials of another host', `${origin}@tracker.example/pixel.gif`],
    ['credentials on this origin', `${origin.replace('://', '://user:pass@')}/old.webp`],
    ['a data: URL', 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['a blob: URL', `blob:${origin}/6f1c0e1c-0000-4000-8000-000000000000`],
    ['a file: URL', 'file:///etc/passwd'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['an ftp: URL', 'ftp://tracker.example/pixel.gif'],
    ['a websocket address', 'wss://tracker.example/pixel'],
    ['an unparseable address', 'http://'],
  ])('refuses %s', (_name, image) => {
    expect(isApprovedCardArt(image)).toBe(false);
  });

  it('judges the address as the page would resolve it, so a <base> pointing elsewhere is refused', () => {
    const base = document.head.appendChild(document.createElement('base'));
    base.href = 'https://tracker.example/';
    try {
      expect(isApprovedCardArt('/old.webp')).toBe(false);
      expect(isApprovedCardArt('old.webp')).toBe(false);
      expect(isApprovedCardArt(`${origin}/old.webp`)).toBe(true);
    } finally {
      base.remove();
    }
    expect(isApprovedCardArt('/old.webp')).toBe(true);
  });

  it('keeps the placeholder a data: image, so showing it requests nothing', () => {
    expect(BLANK_CARD_ART).toMatch(/^data:image\/gif;base64,/);
    expect(isApprovedCardArt(BLANK_CARD_ART)).toBe(false);
  });
});
