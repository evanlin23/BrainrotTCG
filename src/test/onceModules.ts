// Finds the source files that keep state for the life of a page load, for src/test/onceModules.test.ts.
// A plain module (not a setup file) so the detection can be tested on sample sources.

/**
 * True when the source declares, at the top level, a `let`, or a lower-case `const` holding a Map, Set,
 * WeakMap, WeakSet, array, plain object or Promise: the shapes a cache, a once flag, a listener list or a
 * settled promise take. An ALL_CAPS constant is a table, not state; an indented declaration is local to a
 * function. It over-reports on a table named in lower case and misses state kept another way (a class
 * field, a property on an exported object), so the list in docs/DEVELOPMENT.md is the record.
 */
export const keepsStateForTheLoad = (source: string): boolean =>
  /^(?:export )?let [A-Za-z_]\w*/m.test(source) ||
  /^(?:export )?const [a-z]\w*(?::[^=\n]+)? = (?:new (?:Map|Set|WeakMap|WeakSet)\b|\[\]|\{\}|Promise\b)/m.test(source);
