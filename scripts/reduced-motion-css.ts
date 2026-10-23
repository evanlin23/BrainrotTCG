/**
 * Makes the stylesheets' `prefers-reduced-motion` blocks answer the Motion setting too (#765).
 * The setting puts data-motion="reduced" on <html> (utils/motion.ts), and this build step:
 *  - copies every `@media (prefers-reduced-motion: reduce)` block right after itself as plain rules
 *    under :root[data-motion="reduced"], so the copy wins exactly where the original does;
 *  - limits every `prefers-reduced-motion: no-preference` block to :root:not([data-motion="reduced"]).
 * The stylesheets stay the one place motion is written. The prefix is wrapped in :where() where it
 * doesn't start the selector, so no copy outranks the rule it mirrors. Anything it can't mirror
 * faithfully fails the build rather than leaving "Reduced" half-applied.
 */
import type { AtRule, Plugin, Root, Rule } from 'postcss';

const REDUCE = /^\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/i;
const NO_PREFERENCE = /\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/i;
const ROOT = ':root[data-motion="reduced"]';
const NOT_ROOT = ':root:not([data-motion="reduced"])';

/** Splits a selector list at its top-level commas (not inside brackets, parentheses or strings). */
export const splitSelectors = (list: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
};

/** One selector under the root condition: `:root` itself takes it, anything else sits below it. */
export const underRoot = (selector: string, root: string): string => {
  const rootMatch = /^:root(?![\w-])/.exec(selector);
  if (rootMatch) return root + selector.slice(rootMatch[0].length);
  return `:where(${root}) ${selector}`;
};

export const scopeSelectors = (list: string, root: string): string =>
  splitSelectors(list).map((selector) => underRoot(selector, root)).join(', ');

const failure = (at: AtRule, why: string) =>
  new Error(`reduced-motion-css: ${why}: @media ${at.params}. Mirror it by hand or simplify it (scripts/reduced-motion-css.ts).`);

/** The plugin, as a PostCSS plugin object. */
export const reducedMotionCss = (): Plugin => ({
  postcssPlugin: 'reduced-motion-css',
  Once(root: Root) {
    const media: AtRule[] = [];
    root.walkAtRules('media', (at) => { media.push(at); });
    for (const at of media) {
      const params = at.params;
      if (!/prefers-reduced-motion/i.test(params)) continue;
      const rules = (at.nodes ?? []).filter((node) => node.type !== 'comment');
      if (!rules.every((node): node is Rule => node.type === 'rule')) throw failure(at, 'only plain rules can be mirrored');
      if (REDUCE.test(params.trim())) {
        if (at.parent?.type !== 'root') throw failure(at, 'a reduce block must be top-level');
        for (const rule of [...rules].reverse()) {
          const copy = rule.clone();
          copy.selector = scopeSelectors(rule.selector, ROOT);
          at.after(copy);
        }
      } else if (NO_PREFERENCE.test(params)) {
        for (const rule of rules) rule.selector = scopeSelectors(rule.selector, NOT_ROOT);
      } else throw failure(at, 'unsupported reduced-motion query');
    }
  },
});
reducedMotionCss.postcss = true as const;
