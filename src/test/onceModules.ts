// Finds the source files that keep state for the life of a page load, for src/test/onceModules.test.ts.
// A plain module (not a setup file) so the detection can be tested on sample sources.

/**
 * True when the source declares, at the top level, a `let` or `var`, or a `const` (not ALL_CAPS) initialised
 * with an object or array literal, `Object.create(`, a Promise, or a new Map, Set, WeakMap, WeakSet, Array,
 * Object, EventTarget, BroadcastChannel or AbortController: the shapes a cache, a once flag, a listener
 * list or a settled promise take. A name may start with `_` or `$` and carry a type annotation (arrows
 * included). An ALL_CAPS constant is a table, not state; an indented declaration is local to a function.
 * It over-reports on a table named in lower case, and misses state behind another initialiser (a call
 * such as `createStore()`, `new Foo()`), a class field, or a property set on an exported object, so the
 * list in docs/DEVELOPMENT.md is the record.
 */
export const keepsStateForTheLoad = (source: string): boolean =>
  /^(?:export )?(?:let|var) [A-Za-z_$][\w$]*/m.test(source) ||
  /^(?:export )?const (?![A-Z0-9_$]+(?![\w$]))[A-Za-z_$][\w$]*(?::[^\n]*?)? = (?:\{|\[|Object\.create\(|Promise\b|new (?:Map|Set|WeakMap|WeakSet|Array|Object|EventTarget|BroadcastChannel|AbortController)\b)/m.test(source);
