import { readdirSync, readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { reducedMotionCss, scopeSelectors, splitSelectors } from './reduced-motion-css.ts';

const run = async (css: string) => (await postcss([reducedMotionCss()]).process(css, { from: undefined })).css.replace(/\s+/g, ' ').trim();

describe('reduced-motion-css', () => {
  it('splits a selector list only at top-level commas', () => {
    expect(splitSelectors('.a, .b:is(.c, .d), [data-x="1,2"]')).toEqual(['.a', '.b:is(.c, .d)', '[data-x="1,2"]']);
  });

  it('puts :root rules on the root and everything else below it at no extra specificity', () => {
    expect(scopeSelectors(':root, .a > .b::before, *', ':root[data-motion="reduced"]')).toBe(
      ':root[data-motion="reduced"], :where(:root[data-motion="reduced"]) .a > .b::before, :where(:root[data-motion="reduced"]) *',
    );
  });

  it('copies a reduce block after itself as plain rules, in order, keeping !important', async () => {
    const out = await run('.a { x: 1 } @media (prefers-reduced-motion: reduce) { .a { x: 2 } :root { --d: 0ms } *, *::before { y: 1 !important } } .b { z: 1 }');
    expect(out).toBe(
      '.a { x: 1 } @media (prefers-reduced-motion: reduce) { .a { x: 2 } :root { --d: 0ms } *, *::before { y: 1 !important } } '
      + ':where(:root[data-motion="reduced"]) .a { x: 2 } :root[data-motion="reduced"] { --d: 0ms } '
      + ':where(:root[data-motion="reduced"]) *, :where(:root[data-motion="reduced"]) *::before { y: 1 !important } .b { z: 1 }',
    );
  });

  it('limits a no-preference block (even beside another condition) to a root that is not reduced', async () => {
    expect(await run('@media (hover: none) and (prefers-reduced-motion: no-preference) { .a:active { x: 1 } }')).toBe(
      '@media (hover: none) and (prefers-reduced-motion: no-preference) { :where(:root:not([data-motion="reduced"])) .a:active { x: 1 } }',
    );
  });

  it('leaves other media queries alone', async () => {
    const css = '@media (max-width: 600px) { .a { x: 1 } }';
    expect(await run(css)).toBe(css);
  });

  it.each([
    ['a reduce query beside another condition', '@media (hover: none) and (prefers-reduced-motion: reduce) { .a { x: 1 } }'],
    ['a nested at-rule', '@media (prefers-reduced-motion: reduce) { @keyframes k { to { x: 1 } } }'],
    ['a bare query', '@media (prefers-reduced-motion) { .a { x: 1 } }'],
  ])('fails the build on %s', async (_name, css) => {
    await expect(run(css)).rejects.toThrow(/reduced-motion-css/);
  });

  it('mirrors every reduce rule and guards every no-preference rule in the real stylesheets', async () => {
    const dir = new URL('../src/styles/', import.meta.url);
    let mirrored = 0;
    let guarded = 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.css'))) {
      const css = readFileSync(new URL(file, dir), 'utf8');
      const out = (await postcss([reducedMotionCss()]).process(css, { from: undefined })).root;
      const original = postcss.parse(css);
      let reduceRules = 0;
      original.walkAtRules('media', (at) => {
        if (/reduce\s*\)/.test(at.params)) at.walkRules(() => { reduceRules++; });
      });
      let copies = 0;
      out.each((node) => {
        if (node.type === 'rule' && node.selector.includes('[data-motion="reduced"]')) copies++;
        if (node.type === 'atrule' && /no-preference/.test(node.params)) {
          node.walkRules((rule) => {
            expect(rule.selector, file).toContain(':not([data-motion="reduced"])');
            guarded++;
          });
        }
      });
      expect(copies, file).toBe(reduceRules);
      mirrored += copies;
    }
    expect(mirrored).toBeGreaterThan(0);
    expect(guarded).toBeGreaterThan(0);
  });
});
