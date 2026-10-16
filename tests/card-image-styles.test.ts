import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// CardImage's loading states (#226), read from the stylesheet since component tests don't load CSS.
const css = readFileSync(fileURLToPath(new URL('../src/styles/CardImage.css', import.meta.url)), 'utf8');

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
  expect(css).toMatch(/\.card-image \{\s*aspect-ratio: 687 \/ 1024;/);
  for (const state of ['rendering', 'loading', 'failed']) {
    expect(css).toMatch(new RegExp(`\\.card-image\\[data-state='${state}'\\][^{]*\\{[^}]*background`));
  }
});

it('only shimmers for players who allow motion', () => {
  const motion = block('@media (prefers-reduced-motion: no-preference)');
  expect(motion).toMatch(/\[data-state='loading'\]\s*\{\s*animation: card-image-shimmer/);
  expect(css.replace(motion, '')).not.toMatch(/animation\s*:/);
});
