import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// CardImage's loading states (#226), read from the stylesheet since component tests don't load CSS.
const stylesheet = (name: string) => readFileSync(fileURLToPath(new URL(`../src/styles/${name}`, import.meta.url)), 'utf8');
const css = stylesheet('CardImage.css');

/** Every innermost rule as [selector, declarations], inside at-rules too. */
const rules = (text: string) =>
  [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body] as const);
const zIndex = (body: string) => Number(/z-index:\s*(\d+)/.exec(body)?.[1] ?? NaN);

/** One at-rule's whole block, braces balanced. */
const block = (start: string) => {
  const from = css.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', from); i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(from, i + 1);
  }
  throw new Error(`Unclosed ${start}`);
};

it('reserves the card frame shape before any pixels arrive', () => {
  expect(css).toMatch(/\.card-image \{\s*aspect-ratio: var\(--card-aspect\);/);
  expect(stylesheet('tokens.css')).toMatch(/--card-aspect:\s*687 \/ 1024;/);
  for (const state of ['rendering', 'loading', 'failed', 'blocked']) {
    expect(css).toMatch(new RegExp(`\\.card-image\\[data-state='${state}'\\][^{]*\\{[^}]*background`));
  }
});

it('keeps finish captions off a slot whose art is still pending, so it never reads as a card back (#762)', () => {
  // Spacing, quote style, selector order and other rules that also hide things don't matter: find the rule by what it does.
  const normal = (selector: string) => selector.replace(/["']/g, "'").replace(/\s+/g, ' ');
  const hiding = rules(css).filter(([, body]) => /visibility:\s*hidden/.test(body)).map(([selector]) => normal(selector));
  const pendingCaptions = hiding.filter((selector) => /\.mod-label/.test(selector) && /\.collection-mods/.test(selector));
  expect(pendingCaptions).toHaveLength(1);
  const [selector] = pendingCaptions;
  expect(selector).toMatch(/\.card-image/);
  expect(selector).toMatch(/\[data-state='rendering'\]/);
  expect(selector).toMatch(/\[data-state='loading'\]/);
  // Failed and blocked slots keep their caption: they are the hatched "no art" box, not a pending face.
  expect(selector).not.toMatch(/failed|blocked/);
  // A later-sibling combinator keeps layout in place (visibility, not display), and the caption is the target of it.
  expect(selector).toMatch(/~\s*(?::is\()?\s*\.(?:mod-label|collection-mods)/);
  // Each surface prints its caption after the image inside the same button, which is what `~` needs.
  const surfaces: [file: string, caption: RegExp][] = [
    ['ui/PackCardViewer.tsx', /className="mod-label"/],
    ['pack/PackSummaryUI.tsx', /className="mod-label"/],
    ['collection/CollectionBrowser.tsx', /className="collection-mods"/],
  ];
  for (const [file, caption] of surfaces) {
    const source = readFileSync(fileURLToPath(new URL(`../src/components/${file}`, import.meta.url)), 'utf8');
    const image = source.indexOf('<CardImage');
    const printed = source.search(caption);
    expect(image, `${file} draws a CardImage`).toBeGreaterThanOrEqual(0);
    expect(printed, `${file} prints its caption`).toBeGreaterThanOrEqual(0);
    expect(image, `${file} prints its caption after the image`).toBeLessThan(printed);
  }
});

it('gives the small Rankings and pull-row thumbs a placeholder lighter than the shared one', () => {
  const thumb = rules(css).find(([selector]) => /\.hof-cards/.test(selector) && /\.pull-row-thumbs/.test(selector));
  expect(thumb?.[0]).toMatch(/\[data-state='loading'\]/);
  expect(thumb?.[1]).toMatch(/var\(--surface-3\)/);
  expect(thumb?.[1]).toMatch(/var\(--border-strong\)/);
});

it('only shimmers for players who allow motion', () => {
  const motion = block('@media (prefers-reduced-motion: no-preference)');
  expect(motion).toMatch(/\[data-state='loading'\]\s*\{\s*animation: card-image-shimmer/);
  expect(css.replace(motion, '')).not.toMatch(/animation\s*:/);
});

it('pauses the shimmer of images out of view and of the misprint ghost', () => {
  const motion = block('@media (prefers-reduced-motion: no-preference)');
  const paused = rules(motion).find(([, body]) => /animation-play-state:\s*paused/.test(body));
  expect(paused?.[0]).toMatch(/\.card-image\[data-state\]\[data-offscreen\]/);
  expect(paused?.[0]).toMatch(/\.card-image\.misprint-ghost\[data-state\]/);
});

it('lets the failed and blocked slots win over a holo pull-row thumbnail ring', () => {
  const holo = rules(stylesheet('Pulls.css')).filter(([selector, body]) => selector.includes('img.holo') && /background/.test(body));
  expect(holo.length).toBeGreaterThan(0);
  for (const [selector] of holo) {
    expect(selector).toContain(":not([data-state='failed'])");
    expect(selector).toContain(":not([data-state='blocked'])");
  }
});

it('keeps Retry above every card layer it can sit on (holo foil, shine, ghost, stickers)', () => {
  const retry = zIndex(rules(css).find(([selector]) => selector === '.card-image-retry')![1]);
  const layers = ['CardViewer.css', 'Card.css'].flatMap((name) => rules(stylesheet(name)).map(([, body]) => zIndex(body)))
    .filter(Number.isFinite);
  expect(layers.length).toBeGreaterThan(0);
  expect(retry).toBeGreaterThan(Math.max(...layers));
});
