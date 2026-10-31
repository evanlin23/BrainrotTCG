import { describe, expect, it } from 'vitest';
import { keepsStateForTheLoad } from './onceModules';

// The guard for docs/DEVELOPMENT.md, "Modules that keep state for the load": a module whose top-level state
// outlives a test has to be listed there with the way its tests start clean, so a new one is a decision
// someone made, not a leak found by the nightly shuffle. The setup file can't reset it (it has no hook
// into a module's private `let`), and a production export added just for tests is not the default.
const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../test/**', '!../**/*.d.ts'], { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const docs = import.meta.glob('../../docs/DEVELOPMENT.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

const HEADING = '### Modules that keep state for the load';

/** The `src/...` paths the doc's list names, from the heading to the next section. */
const listed = (doc: string): string[] => {
  const start = doc.indexOf(HEADING);
  if (start < 0) return [];
  const rest = doc.slice(start + HEADING.length);
  const end = rest.indexOf('\n## ');
  return [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/`(src\/[^`\s]+\.tsx?)`/g)].map((match) => match[1]);
};

describe('detecting top-level state', () => {
  it('flags a let, and a lower-case const holding a Map, Set, WeakMap, WeakSet, array, object or Promise', () => {
    expect(keepsStateForTheLoad('let settled = false;')).toBe(true);
    expect(keepsStateForTheLoad('export let current: Job | null = null;')).toBe(true);
    expect(keepsStateForTheLoad('const cache = new Map<string, number>();')).toBe(true);
    expect(keepsStateForTheLoad('const seen: Set<string> = new Set();')).toBe(true);
    expect(keepsStateForTheLoad('const byTicket = new WeakMap<object, number>();')).toBe(true);
    expect(keepsStateForTheLoad('const stack: string[] = [];')).toBe(true);
    expect(keepsStateForTheLoad('const shipped = Promise.resolve()\n  .then(load);')).toBe(true);
    expect(keepsStateForTheLoad('import x from "y";\n\nconst waiting = [];')).toBe(true);
    // The shapes a first version missed.
    expect(keepsStateForTheLoad('const listeners: Set<() => void> = new Set();')).toBe(true);
    expect(keepsStateForTheLoad('const state = { ready: false };')).toBe(true);
    expect(keepsStateForTheLoad('const queue = [a, b];')).toBe(true);
    expect(keepsStateForTheLoad('var flag = false;')).toBe(true);
    expect(keepsStateForTheLoad('const _memo = new Map();')).toBe(true);
    expect(keepsStateForTheLoad('const $cache = new Map();')).toBe(true);
    expect(keepsStateForTheLoad('export const seam = { load: () => import("x") };')).toBe(true);
    expect(keepsStateForTheLoad('const bus = new EventTarget();')).toBe(true);
    expect(keepsStateForTheLoad('const channel = new BroadcastChannel("x");')).toBe(true);
    expect(keepsStateForTheLoad('const slots = new Array(4);')).toBe(true);
    expect(keepsStateForTheLoad('const abort = new AbortController();')).toBe(true);
    expect(keepsStateForTheLoad('const bare = Object.create(null);')).toBe(true);
    expect(keepsStateForTheLoad('const bare: Record<string, number> = Object.create(null);')).toBe(true);
  });

  it('leaves out tables in ALL_CAPS, local declarations, immutable consts and comments', () => {
    expect(keepsStateForTheLoad('const KEYS = new Set(["Enter"]);')).toBe(false);
    expect(keepsStateForTheLoad('export const run = () => {\n  let count = 0;\n  const seen = new Set<string>();\n  return count;\n};')).toBe(false);
    expect(keepsStateForTheLoad('export const VERSION = 3;\nconst name = "x";\nconst now = () => 1;')).toBe(false);
    expect(keepsStateForTheLoad('// let settled = false;\n/* const cache = new Map(); */')).toBe(false);
    expect(keepsStateForTheLoad('const MAX_RETRIES = 3;\nconst TABLE = { a: 1 };\nconst _LIMITS = [1, 2];\nconst $KEYS = new Set();')).toBe(false);
    expect(keepsStateForTheLoad('const now = () => ({ a: 1 });\nconst total = count + [1].length;')).toBe(false);
  });
});

describe('modules that keep state for the load', () => {
  const doc = Object.values(docs)[0] ?? '';
  const withState = Object.entries(sources)
    .filter(([, source]) => keepsStateForTheLoad(source))
    .map(([path]) => path.replace(/^\.\.\//, 'src/'))
    .sort();

  it('has source files to check, and the list to check them against', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(withState.length).toBeGreaterThan(10);
    expect(listed(doc).length).toBeGreaterThan(10);
  });

  it('are all listed in docs/DEVELOPMENT.md, with the way their tests start clean', () => {
    const names = new Set(listed(doc));
    expect(withState.filter((path) => !names.has(path))).toEqual([]);
  });

  it('are the only ones listed there (a module that lost its state, or moved, comes off the list)', () => {
    const real = new Set(withState);
    expect(listed(doc).filter((path) => !real.has(path))).toEqual([]);
  });
});
