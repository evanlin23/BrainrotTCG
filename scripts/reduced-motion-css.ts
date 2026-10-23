/**
 * Makes the stylesheets' `prefers-reduced-motion` blocks answer the Motion setting too (#765).
 * The setting puts data-motion="reduced" on <html> (utils/motion.ts), and this build step:
 *  - copies every `@media (prefers-reduced-motion: reduce)` block right after itself as plain rules
 *    under :root[data-motion="reduced"], so the copy wins exactly where the original does;
 *  - limits every `prefers-reduced-motion: no-preference` block to :root:not([data-motion="reduced"]).
 * The stylesheets stay the one place motion is written. No copy outranks the rule it mirrors: the
 * condition is wrapped in :where() (zero specificity), so a selector led by :root becomes
 * `:root:where([data-motion="reduced"])` and any other becomes `:where(:root[data-motion="reduced"]) <selector>`,
 * and each keeps the specificity of the selector it came from. A selector that can't be placed that way fails
 * the build rather than leaving "Reduced" half-applied: one led by `html` (it IS the root, so it can't sit below
 * it), one with :root anywhere but first, one led by a combinator, `&`, a bare pseudo-class or an attribute
 * (it could be the root itself), and any rule that isn't plain.
 */
import type { AtRule, Plugin, Root, Rule } from 'postcss';

const REDUCE = /^\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/i;
const NO_PREFERENCE = /\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/i;
/** A root condition in the two shapes a selector needs it in. Both add no specificity. */
export interface Scope {
  /** For a selector led by :root: the condition joins it. */
  self: string;
  /** For any other selector: the condition sits above it. */
  below: string;
}
export const REDUCED: Scope = { self: ':root:where([data-motion="reduced"])', below: ':where(:root[data-motion="reduced"])' };
export const CALM: Scope = { self: ':root:where(:not([data-motion="reduced"]))', below: ':where(:root:not([data-motion="reduced"]))' };

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

/** One selector under the root condition, or an error naming why it can't be. */
export const underRoot = (selector: string, scope: Scope): string => {
  const rootMatch = /^:root(?![\w-])/.exec(selector);
  const rest = rootMatch ? selector.slice(rootMatch[0].length) : selector;
  if (/^html(?![\w-])/i.test(selector)) throw new Error(`"${selector}" is led by html, which is the root and can't sit below it; lead it with :root`);
  // Quoted text and attribute values aren't selectors.
  const bare = rest.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'/g, '');
  if (/(?:^|[^\w-])(?:html|:root)(?![\w-])/i.test(bare)) throw new Error(`"${selector}" names the root element somewhere other than its start`);
  if (rootMatch) return scope.self + rest;
  if (/^[>+~&:[]/.test(selector)) throw new Error(`"${selector}" starts with a combinator, &, a pseudo-class or an attribute, which could be the root itself`);
  // A universal selector reaches the root too; the mirror must as well. The root half drops the `*` and joins the
  // condition (which weighs nothing) to the rest, so it weighs what the original does.
  if (/^\*(?![\w-])/.test(selector)) return `${scope.below}${selector.slice(1)}, ${scope.below} ${selector}`;
  // A class- or id-led selector could match <html class="x"> too; no stylesheet does that, and the mirror
  // places it below the root.
  return `${scope.below} ${selector}`;
};

export const scopeSelectors = (list: string, scope: Scope): string =>
  splitSelectors(list).map((selector) => underRoot(selector, scope)).join(', ');

const failure = (at: AtRule, why: string) =>
  new Error(`reduced-motion-css: ${why}: @media ${at.params}. Mirror it by hand or simplify it (scripts/reduced-motion-css.ts).`);

const scoped = (at: AtRule, rule: Rule, scope: Scope): string => {
  try {
    return scopeSelectors(rule.selector, scope);
  } catch (error) {
    throw failure(at, (error as Error).message);
  }
};

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
          copy.selector = scoped(at, rule, REDUCED);
          at.after(copy);
        }
      } else if (NO_PREFERENCE.test(params)) {
        for (const rule of rules) rule.selector = scoped(at, rule, CALM);
      } else throw failure(at, 'unsupported reduced-motion query');
    }
  },
});
reducedMotionCss.postcss = true as const;
