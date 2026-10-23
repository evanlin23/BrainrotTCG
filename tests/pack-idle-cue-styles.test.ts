import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The sealed pack's idle cue (docs/DESIGN.md Flow 2) is CSS alone, and component tests don't load CSS,
// so the rules that keep it calm and out of the gesture's way are checked here.
const css = readFileSync(fileURLToPath(new URL('../src/styles/PackOpener.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the `@media` block that starts with the given query, with nested braces kept. */
const mediaBlocks = (query: string): string[] => {
  const blocks: string[] = [];
  for (let at = css.indexOf(`@media (${query})`); at !== -1; at = css.indexOf(`@media (${query})`, at + 1)) {
    let depth = 0;
    const start = css.indexOf('{', at);
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) {
        blocks.push(css.slice(start + 1, i));
        break;
      }
    }
  }
  return blocks;
};

const idleRules = (block: string) =>
  [...block.matchAll(/([^{}]*\.is-idle[^{}]*)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({ selectors: selectors.split(',').map((selector) => selector.trim()), body: body.trim() }));

describe('the idle cue styles', () => {
  const calm = mediaBlocks('prefers-reduced-motion: no-preference').flatMap(idleRules);
  const reduced = mediaBlocks('prefers-reduced-motion: reduce').flatMap(idleRules);

  it('animates only where motion is welcome, and only the strip and what is stuck on it', () => {
    expect(calm).toHaveLength(1);
    expect(calm[0].selectors).toEqual(['.pack-shell.is-idle .pack-half-top', '.pack-shell.is-idle .pack-top-piece']);
    expect(calm[0].body).toMatch(/animation:\s*pack-idle-lift /);
    const outside = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    expect(outside).not.toMatch(/\.is-idle[^{}]*\{[^}]*animation/);
  });

  it('runs on the compositor: the one keyframe set changes transform and nothing else', () => {
    const keyframes = [...css.matchAll(/@keyframes (pack-idle-[\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
    expect(keyframes.map(([, name]) => name)).toEqual(['pack-idle-lift']);
    expect(keyframes[0][2]).toMatch(/^(?:[^{}]*\{\s*(?:transform:[^;]*;\s*)+\})+\s*$/);
  });

  it('shows a still perforation under reduced motion, with no animation and no gap', () => {
    expect(reduced).toHaveLength(1);
    expect(reduced[0].selectors).toEqual(['.pack-shell.is-idle .pack-top-piece::after']);
    expect(reduced[0].body).not.toMatch(/animation|transform/);
    expect(reduced[0].body).toMatch(/border-top:\s*\d+px dashed/);
  });

  it('leaves the gesture alone: no idle rule touches the shell, the tear guide, the hint or the hit area', () => {
    for (const selector of [...calm, ...reduced].flatMap((rule) => rule.selectors)) expect(selector).toMatch(/\.pack-half-top$|\.pack-top-piece$|\.pack-top-piece::after$/);
  });

  it('seats the bottom half under the strip without a hairline, with no keyframes on its clip', () => {
    expect(css).toMatch(/\.pack-shell:not\(\.is-cut\) \.pack-half-bottom\s*\{\s*clip-path:\s*inset\(calc\(var\(--tear-y\) - 0\.1%\) 0 0 0\);/);
    expect(css).toMatch(/\.pack-shell:not\(\.is-cut\) \.pack-half-top\s*\{\s*opacity:\s*1;/);
  });
});
