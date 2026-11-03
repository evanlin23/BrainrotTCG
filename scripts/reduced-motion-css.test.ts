import { readdirSync, readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { CALM, REDUCED, reducedMotionCss, scopeSelectors, splitSelectors, underRoot } from './reduced-motion-css.ts';

const run = async (css: string) => (await postcss([reducedMotionCss()]).process(css, { from: undefined })).css.replace(/\s+/g, ' ').trim();

describe('reduced-motion-css', () => {
  it('splits a selector list only at top-level commas', () => {
    expect(splitSelectors('.a, .b:is(.c, .d), [data-x="1,2"]')).toEqual(['.a', '.b:is(.c, .d)', '[data-x="1,2"]']);
  });

  it('puts :root rules on the root and everything else below it, with no specificity added', () => {
    expect(scopeSelectors(':root, .a > .b::before, #c .d', REDUCED)).toBe(
      ':root:where([data-motion="reduced"]), :where(:root[data-motion="reduced"]) .a > .b::before, :where(:root[data-motion="reduced"]) #c .d',
    );
    expect(scopeSelectors(':root.big .a', CALM)).toBe(':root:where(:not([data-motion="reduced"])).big .a');
  });

  it('lets a universal selector reach the root too', () => {
    expect(scopeSelectors('*, *::before', REDUCED)).toBe(
      ':where(:root[data-motion="reduced"]), :where(:root[data-motion="reduced"]) *, :where(:root[data-motion="reduced"])::before, :where(:root[data-motion="reduced"]) *::before',
    );
  });

  it('gives the copy the specificity of the selector it mirrors', () => {
    // Weights as (ids, classes/attributes/pseudo-classes, types): :where() counts for nothing.
    const weight = (selector: string) => {
      const bare = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '');
      return [(bare.match(/#[\w-]+/g) ?? []).length, (bare.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length, (bare.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length];
    };
    for (const selector of [':root', ':root.big', '.a', '.a > .b', '#c .d:hover', 'button']) {
      expect(weight(underRoot(selector, REDUCED)), selector).toEqual(weight(selector));
      expect(weight(underRoot(selector, CALM)), selector).toEqual(weight(selector));
    }
    // A universal selector becomes two selectors, the root and everything below it; each weighs what it did.
    for (const selector of ['*', '*.a', '*[hidden]', '*:hover', '*::before', '* > .a']) {
      for (const scope of [REDUCED, CALM]) {
        for (const half of splitSelectors(underRoot(selector, scope))) expect(weight(half), `${selector} -> ${half}`).toEqual(weight(selector));
      }
    }
  });

  it('copies a reduce block after itself as plain rules, in order, keeping !important', async () => {
    const out = await run('.a { x: 1 } @media (prefers-reduced-motion: reduce) { .a { x: 2 } :root { --d: 0ms } *, *::before { y: 1 !important } } .b { z: 1 }');
    expect(out).toBe(
      '.a { x: 1 } @media (prefers-reduced-motion: reduce) { .a { x: 2 } :root { --d: 0ms } *, *::before { y: 1 !important } } '
      + ':where(:root[data-motion="reduced"]) .a { x: 2 } :root:where([data-motion="reduced"]) { --d: 0ms } '
      + ':where(:root[data-motion="reduced"]), :where(:root[data-motion="reduced"]) *, :where(:root[data-motion="reduced"])::before, :where(:root[data-motion="reduced"]) *::before { y: 1 !important } .b { z: 1 }',
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
    // html is the root itself: `:where(:root[…]) html` could never match, so a copy would silently do nothing.
    ['a reduce rule led by html', '@media (prefers-reduced-motion: reduce) { html { x: 1 } }'],
    ['a reduce rule led by html with a class', '@media (prefers-reduced-motion: reduce) { html.big .a { x: 1 } }'],
    ['a no-preference rule led by html', '@media (prefers-reduced-motion: no-preference) { html .a { x: 1 } }'],
    ['a reduce rule with :root below its start', '@media (prefers-reduced-motion: reduce) { .a :root { x: 1 } }'],
    ['a reduce rule led by a pseudo-class', '@media (prefers-reduced-motion: reduce) { :not(.a) { x: 1 } }'],
    ['a reduce rule led by a combinator', '@media (prefers-reduced-motion: reduce) { > .a { x: 1 } }'],
    ['a reduce rule led by an attribute', '@media (prefers-reduced-motion: reduce) { [data-x] .a { x: 1 } }'],
  ])('fails the build on %s', async (_name, css) => {
    await expect(run(css)).rejects.toThrow(/reduced-motion-css/);
  });

  it('names the selector it cannot scope, and does not mistake html inside an attribute value for the root', async () => {
    await expect(run('@media (prefers-reduced-motion: reduce) { .ok, html.big { x: 1 } }')).rejects.toThrow(/"html\.big" is led by html/);
    await expect(run('@media (prefers-reduced-motion: reduce) { a[href$=".html"] { x: 1 } }')).resolves.toContain(':where(:root[data-motion="reduced"]) a[href$=".html"]');
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

  it('specifically covers the pack opener calm-downs (pack foil, idle lift, seam shimmer, ceremony)', async () => {
    const dir = new URL('../src/styles/', import.meta.url);
    const css = readFileSync(new URL('PackOpener.css', dir), 'utf8');
    const result = await postcss([reducedMotionCss()]).process(css, { from: undefined });
    const decls = new Map<string, Record<string, string>>();
    result.root.walkRules((rule) => {
      const selectors = rule.selector.split(',').map((s) => s.trim());
      const d: Record<string, string> = {};
      rule.walkDecls((decl) => { d[decl.prop] = decl.value; });
      for (const sel of selectors) {
        decls.set(sel, { ...decls.get(sel), ...d });
      }
    });
    expect(decls.get(':where(:root[data-motion="reduced"]) .pack-foil::before')).toMatchObject({ animation: 'none' });
    expect(decls.get(':where(:root[data-motion="reduced"]) .cut-line')).toMatchObject({ animation: 'none' });
    expect(decls.get(':where(:root[data-motion="reduced"]) .showcase-halo')).toMatchObject({ animation: 'none' });
    expect(decls.get(':where(:root[data-motion="reduced"]) .showcase-halo::before')).toMatchObject({ animation: 'none' });
    const idleRule = decls.get(':where(:root:not([data-motion="reduced"])) .pack-shell.is-idle .pack-half-top');
    expect(idleRule?.animation).toContain('pack-idle-lift');
  });
});
