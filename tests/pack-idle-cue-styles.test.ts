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

const idleRules = (block: string) => [...block.matchAll(/([^{}]*\.is-idle[^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body: body.trim() }));

describe('the idle cue styles', () => {
  const calm = mediaBlocks('prefers-reduced-motion: no-preference').flatMap(idleRules);
  const reduced = mediaBlocks('prefers-reduced-motion: reduce').flatMap(idleRules);

  it('animates only where motion is welcome', () => {
    expect(calm.map((rule) => rule.selector)).toEqual(['.pack-shell.is-idle .pack-half-top', '.pack-shell.is-idle .pack-top-piece', '.pack-shell.is-idle .pack-half-bottom']);
    expect(calm.every((rule) => /animation:\s*pack-idle-/.test(rule.body))).toBe(true);
    const outside = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    expect(outside).not.toMatch(/\.is-idle[^{}]*\{[^}]*animation/);
  });

  it('holds a still seam under reduced motion, with no animation at all', () => {
    expect(reduced.map((rule) => rule.selector)).toEqual(['.pack-shell.is-idle .pack-half-top', '.pack-shell.is-idle .pack-top-piece', '.pack-shell.is-idle .pack-half-bottom']);
    for (const rule of reduced) expect(rule.body).not.toMatch(/animation/);
    expect(reduced.some((rule) => /translateY\(-0\.\d+%\)/.test(rule.body))).toBe(true);
  });

  it('moves only the picture: no rule for the idle state touches the shell, the tear guide, the hint or the hit area', () => {
    const selectors = [...calm, ...reduced].map((rule) => rule.selector);
    for (const selector of selectors) expect(selector).toMatch(/\.pack-half-top$|\.pack-top-piece$|\.pack-half-bottom$/);
    const keyframes = [...css.matchAll(/@keyframes (pack-idle-[\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
    expect(keyframes.map(([, name]) => name).sort()).toEqual(['pack-idle-piece', 'pack-idle-seat', 'pack-idle-strip']);
    for (const [, name, body] of keyframes) expect(body, name).toMatch(/^(?:[^{}]*\{\s*(?:(?:opacity|transform|clip-path):[^;]*;\s*)+\})+\s*$/);
  });
});
