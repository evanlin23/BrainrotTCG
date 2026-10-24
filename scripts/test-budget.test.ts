import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createVitest, parseCLI, type TestModule, type Vitest } from 'vitest/node';
import TestBudgetReporter, { HANG_TIMEOUT_MS, TEST_BUDGET_REPORTER, runSummary } from './test-budget';

const fakeModule = (tests: number) => ({ children: { allTests: function* () { for (let i = 0; i < tests; i++) yield {}; } } }) as unknown as TestModule;

/** Runs the reporter over two modules (3 + 2 tests) that took `seconds`, and returns what it logged. */
const run = (seconds: number, { watch = false, npmScript = 'test' } = {}) => {
  const logged: { log: string[]; error: string[] } = { log: [], error: [] };
  const vitest = { config: { watch }, logger: { log: (line: string) => logged.log.push(line), error: (line: string) => logged.error.push(line) } } as unknown as Vitest;
  let clock = 1000;
  const reporter = new TestBudgetReporter({ now: () => clock, env: { npm_lifecycle_event: npmScript } });
  reporter.onInit(vitest);
  clock += seconds * 1000;
  reporter.onTestRunEnd([fakeModule(3), fakeModule(2)]);
  return logged;
};

describe('test run timing', () => {
  const exitCode = process.exitCode;
  afterEach(() => { process.exitCode = exitCode; });

  it('reports the time and test count of a run', () => {
    expect(runSummary({ seconds: 61.94, tests: 798, files: 81 })).toBe('Test time: 798 tests in 81 files took 61.9s (report-only)');
    expect(run(12)).toEqual({ log: ['Test time: 5 tests in 2 files took 12.0s (report-only)'], error: [] });
    expect(process.exitCode).toBe(exitCode);
  });

  it('never fails a run, however long it took', () => {
    // A loaded machine can take many times as long; the old 400 s budget failed such runs.
    expect(run(4000)).toEqual({ log: ['Test time: 5 tests in 2 files took 4000.0s (report-only)'], error: [] });
    expect(process.exitCode).toBe(exitCode);
  });

  it('leaves runs outside npm test, and watch runs, alone', () => {
    expect(run(20.5, { npmScript: '' })).toEqual({ log: [], error: [] });
    expect(run(20.5, { npmScript: 'test:browser' })).toEqual({ log: [], error: [] });
    expect(run(20.5, { watch: true })).toEqual({ log: [], error: [] });
    expect(process.exitCode).toBe(exitCode);
  });
});

describe('test run wiring', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const npmTest = (JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { scripts: { test: string } }).scripts.test;

  // Resolves Vitest's config for `npm test -- <flags>` the way the CLI does, without running tests.
  it.each([[], ['--reporter=dot'], ['--reporter=json', '--coverage.enabled=false']])('keeps the timing reporter, the hang timeout and no retry in npm test %j', async (...flags: string[]) => {
    const { options } = parseCLI([...npmTest.split(' '), ...flags]);
    const vitest = await createVitest('test', { ...options, root, watch: false });
    try {
      // createVitest loads the configured reporters, so a bad path would already have thrown.
      expect(vitest.config.reporters.filter((reporter) => Array.isArray(reporter) && reporter[0] === TEST_BUDGET_REPORTER)).toEqual([[TEST_BUDGET_REPORTER, {}]]);
      // A tighter --testTimeout in the script would turn load into failures again.
      expect([vitest.config.testTimeout, vitest.config.hookTimeout]).toEqual([HANG_TIMEOUT_MS, HANG_TIMEOUT_MS]);
      // A retry in the script or config would hide a flaky test behind a pass.
      expect(vitest.config.retry).toBe(0);
    } finally { await vitest.close(); }
  });

  it('applies the hang timeout, and no retry, to targeted runs too', async () => {
    const vitest = await createVitest('test', { root, watch: false });
    try {
      expect([vitest.config.testTimeout, vitest.config.hookTimeout]).toEqual([HANG_TIMEOUT_MS, HANG_TIMEOUT_MS]);
      expect(vitest.config.retry).toBe(0);
    } finally { await vitest.close(); }
  });
});

/**
 * The hang guard, the one timeout a test file may name, in any slot or options object: vite.config.ts
 * already sets it for every test and hook, so naming it changes nothing.
 */
const HANG_GUARD = 'HANG_TIMEOUT_MS';
const isHangGuard = (node: ts.Node) => ts.isIdentifier(node) && node.text === HANG_GUARD;

/** Vitest's test and suite functions. A file's own aliases of them are added per file (runnersIn). */
const RUNNERS = ['it', 'test', 'describe', 'suite'];
/** Functions taking (fn, timeout): the four hooks and the two wrapping hooks (Vitest 5), which take a timeout as well. */
const HOOKS = ['beforeAll', 'beforeEach', 'afterAll', 'afterEach', 'aroundAll', 'aroundEach'];
/** Functions taking (fn, timeout) that run after a test, on any receiver. */
const AFTER_TEST = ['onTestFinished', 'onTestFailed'];

/**
 * What the guard reports, each with its own message. All fail: no test sets its own timeout, retries,
 * or changes the config at run time. `opaque` is a conservative flag: the timeout slot or options
 * object is a variable, a call or a spread, which the guard does not try to evaluate.
 */
const LIMITS = {
  timeout: 'sets its own timeout',
  retry: 'retries a failure',
  opaque: 'passes timeout options the guard cannot read (a variable, call or spread); write them out',
  config: 'changes the test config with vi.setConfig',
} as const;
type Limit = keyof typeof LIMITS;

/** The member `v['it']` names, when written as a string. */
const memberName = (node: ts.ElementAccessExpression) => ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;

/** Whether `node` is a member of a namespace import of vitest: `v.it`, `v['it']`. */
const isNamespaceMember = (node: ts.Expression, namespaces: ReadonlySet<string>): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
  (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text);

/**
 * The identifier a call chain starts from: `it` for it(...), it.only(...), it.each(...)(...),
 * it.each`...`(...) and it['only'](...). A namespace import (`import * as v from 'vitest'`) is
 * skipped, so v.it.only(...) starts from `it` and v.vi.setConfig(...) from `vi`.
 */
const rootName = (node: ts.Expression, namespaces: ReadonlySet<string>): string | undefined => {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isTaggedTemplateExpression(node)) return rootName(node.tag, namespaces);
  if (isNamespaceMember(node, namespaces)) return ts.isPropertyAccessExpression(node) ? node.name.text : memberName(node);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)
    || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return rootName(node.expression, namespaces);
  return undefined;
};

/** The name a call ends on: `beforeEach` for beforeEach(...), test.beforeEach(...) and test['beforeEach'](...). */
const calleeName = (node: ts.Expression) =>
  ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? memberName(node) : undefined;

/** A module specifier of vitest itself, in import('vitest') and require('vitest') too. */
const isVitestSpecifier = (node: ts.Node | undefined) => node !== undefined && ts.isStringLiteralLike(node) && node.text === 'vitest';

/** The names a file binds to the whole vitest module: `import * as v`, `await import('vitest')` and `require('vitest')`. */
const namespacesIn = (sourceFile: ts.SourceFile) => {
  const names = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && isVitestSpecifier(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let value = node.initializer;
      while (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
      if (ts.isCallExpression(value) && isVitestSpecifier(value.arguments[0])
        && (value.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(value.expression) && value.expression.text === 'require'))) names.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  return names;
};

/**
 * Vitest's runners plus the names this file gives them: `const slow = test.extend(...)`, chains of
 * those in any order, `import { it as spec }` and `const slow = v.test.extend(...)`.
 */
const runnersIn = (sourceFile: ts.SourceFile, namespaces: ReadonlySet<string>) => {
  const names = new Set(RUNNERS);
  const aliases: { name: string; value: ts.Expression }[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && node.propertyName && names.has(node.propertyName.text)) names.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) aliases.push({ name: node.name.text, value: node.initializer });
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, value } of aliases) {
      const root = rootName(value, namespaces);
      if (!names.has(name) && root !== undefined && names.has(root)) { names.add(name); grew = true; }
    }
  }
  return names;
};

/** A property's key as written: `timeout`, 'timeout' and ['timeout'] all name `timeout`; a spread has none. */
const keyName = (property: ts.ObjectLiteralElementLike) => {
  if (ts.isSpreadAssignment(property)) return undefined;
  const { name } = property;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
};

/**
 * What an options object sets: `timeout` as anything but the hang guard (`{ timeout }` included), any
 * retry, and anything the guard can't read: a spread (`{ ...opts }`) or a computed key it can't resolve.
 */
const limitsIn = (options: ts.ObjectLiteralExpression) =>
  options.properties.flatMap((property): Limit[] => {
    const key = keyName(property);
    if (key === 'retry') return ['retry'];
    if (key === undefined) return ['opaque'];
    if (key !== 'timeout') return [];
    return ts.isPropertyAssignment(property) && isHangGuard(property.initializer) ? [] : ['timeout'];
  });

const isFunction = (node: ts.Expression) => ts.isArrowFunction(node) || ts.isFunctionExpression(node);

/**
 * What a timeout slot holds: nothing for the function or the hang guard, an options object's limits,
 * a number or other literal is a timeout, and any other expression (a variable, a call) is opaque.
 */
const limitsOf = (node: ts.Expression | undefined): Limit[] => {
  if (!node || isFunction(node) || isHangGuard(node)) return [];
  if (ts.isObjectLiteralExpression(node)) return limitsIn(node);
  return ts.isIdentifier(node) || ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? ['opaque'] : ['timeout'];
};

const limitsOfCall = (call: ts.CallExpression, runners: ReadonlySet<string>, namespaces: ReadonlySet<string>): Limit[] => {
  const root = rootName(call.expression, namespaces);
  const callee = calleeName(call.expression);
  const args = call.arguments;
  // A spread argument list (it(...args)) hides every slot, so it is reported as unreadable.
  const spread = args.some(ts.isSpreadElement) ? ['opaque' as const] : [];
  // beforeEach(fn, 10_000) and aroundEach(fn, { timeout }), bare, through a namespace import or on a test: test.beforeEach(...).
  if (callee !== undefined && HOOKS.includes(callee) && (ts.isIdentifier(call.expression) || isNamespaceMember(call.expression, namespaces) || (root !== undefined && runners.has(root)))) return [...spread, ...limitsOf(args[1])];
  // onTestFinished(fn, 5) and onTestFailed(fn, { timeout }), on any receiver: they are also reached through the test context (`ctx.onTestFinished`).
  if (callee !== undefined && AFTER_TEST.includes(callee)) return [...spread, ...limitsOf(args[1])];
  // vi.setConfig(...) with any argument: a literal could name a timeout or retry, a variable or spread anything, and no test needs it.
  if (callee === 'setConfig' && (root === 'vi' || root === 'vitest')) return args.length > 0 ? ['config'] : [];
  if (root === undefined || !runners.has(root)) return [];
  if (spread.length > 0) return spread;
  // it(name, options, fn), and the same for test, describe, suite, their chains (it.each(...)(...),
  // it.each`...`(...), describe.concurrent(...)) and aliases: the function is the third argument.
  if (args[1] && ts.isObjectLiteralExpression(args[1])) return limitsIn(args[1]);
  // it(name, opts, fn): a variable or call in the options slot, before a function. With no function
  // after it, it is the test function itself (it('i', runCase)), or the timeout of it(name, fn, 5).
  if (args[1] && args[2] && isFunction(args[2]) && !isFunction(args[1]) && !isHangGuard(args[1])) return limitsOf(args[1]);
  // it(name, fn, 30_000) and it(name, fn, options).
  return limitsOf(args[2]);
};

/**
 * Where `source` gives a test, suite or hook its own timeout, a retry, or changes the config with
 * vi.setConfig, as `file:line message`. Only the hang guard (HANG_TIMEOUT_MS, set for every test and
 * hook in vite.config.ts) may be named: a per-test ceiling fails a test on a busy runner rather than
 * on a bug, and a retry hides a flake (docs/DEVELOPMENT.md, Test timing).
 *
 * Covered: the timeout and options slots of it, test, describe and suite, their chains (.each in both
 * forms, .concurrent, .only) and the file's own aliases (test.extend(...), `import { it as spec }`);
 * the timeout slot of beforeAll, beforeEach, afterAll, afterEach, aroundAll, aroundEach, onTestFinished
 * and onTestFailed;
 * any vi.setConfig call with an argument; and all of these through a namespace import
 * (`import * as v from 'vitest'`, `await import('vitest')`, `require('vitest')`).
 *
 * Conservative, so it can flag what it can't evaluate: an options object that is a variable or call,
 * or has a spread, and an argument list with a spread (`it(...args)`), are reported (as unreadable)
 * rather than followed, and vi.setConfig is reported whatever it is given. A guarded test must write
 * its options out.
 *
 * Not covered, because finding them needs types or data flow rather than syntax: `vi` or a hook
 * renamed on import (`import { vi as v }`) or destructured (`const { it } = await import('vitest')`),
 * a runner or namespace passed around as a value (`const run = it; run(...)`, `const w = v; w.it(...)`),
 * the waits that take their own timeout and are not a test or hook ceiling (`vi.waitFor`, `vi.waitUntil`,
 * `expect.poll`), and the CLI or environment
 * (`--testTimeout`, `--retry`): the 'test run wiring' tests above check the resolved config for those.
 */
const ownLimits = (file: string, source: string) => {
  const found: string[] = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const namespaces = namespacesIn(sourceFile);
  const runners = runnersIn(sourceFile, namespaces);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      for (const limit of new Set(limitsOfCall(node, runners, namespaces))) found.push(`${file}:${line} ${LIMITS[limit]}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

describe('one timeout for every test, and no retries', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));

  it('finds a test, suite or hook that sets its own timeout or a retry, and nothing else', () => {
    // Each line of the source, and what the guard must report on it.
    const lines: [string, Limit[]][] = [
      ["it('a', async () => {}, 30_000);", ['timeout']],
      ["test('b', { timeout: 5000 }, () => {});", ['timeout']],
      ["it.each([[1]])('c %s', async () => {}, 60_000);", ['timeout']],
      ["it.concurrent('d', () => {}, { timeout: 1 });", ['timeout']],
      ['beforeEach(() => {}, 10_000);', ['timeout']],
      // Suites.
      ["describe('s1', { timeout: 5000 }, () => {});", ['timeout']],
      ["describe('s2', () => {}, 5);", ['timeout']],
      ["suite('s3', () => {}, 5);", ['timeout']],
      ["suite.each([[1]])('s4', { timeout: 5 }, () => {});", ['timeout']],
      // Other ways to write the key.
      ["const timeout = 5; it('k1', { timeout }, () => {});", ['timeout']],
      ["it('k2', { 'timeout': 5 }, () => {});", ['timeout']],
      ["it('k3', () => {}, { ['timeout']: 5 });", ['timeout']],
      // Aliases: test.extend, chains of them in any order, an import rename, and a hook on an alias.
      ["const slow = test.extend({}); slow('x1', () => {}, 5000);", ['timeout']],
      ["slower('x2', { timeout: 5 }, () => {}); const slower = slow.extend({});", ['timeout']],
      ["import { it as spec } from 'vitest'; spec('x3', () => {}, 5);", ['timeout']],
      ['slow.beforeEach(() => {}, 5);', ['timeout']],
      // The tagged-template table form.
      ["it.each`a | b`('t1 $a', () => {}, 5000);", ['timeout']],
      ["test.each`a`('t2', { timeout: 5 }, () => {});", ['timeout']],
      // Retries, reported as retries.
      ["it('r1', { retry: 2 }, () => {});", ['retry']],
      ["describe('r2', () => {}, { retry: 1 });", ['retry']],
      ["it('r3', { timeout: 1, retry: 1 }, () => {});", ['timeout', 'retry']],
      // Options the guard can't read are flagged rather than evaluated: a variable, a call or a spread, in either argument order.
      ["const opts = { timeout: 5 }; it('o1', () => {}, opts);", ['opaque']],
      ["const opts = { timeout: 5 }; it('o2', opts, () => {});", ['opaque']],
      ["test('o3', { ...opts }, () => {});", ['opaque']],
      ["it('o4', () => {}, { ...opts });", ['opaque']],
      ["it('o5', { concurrent: true, ...opts }, () => {});", ['opaque']],
      ["it('o6', () => {}, makeOptions());", ['opaque']],
      ["describe('o7', opts, () => {});", ['opaque']],
      ['beforeEach(() => {}, opts);', ['opaque']],
      ['afterAll(() => {}, { ...opts });', ['opaque']],
      ["it('o8', { retry: 1, ...opts }, () => {});", ['retry', 'opaque']],
      // vi.setConfig with any argument, and on vitest.
      ['vi.setConfig({ testTimeout: 1000 });', ['config']],
      ['vi.setConfig({ hookTimeout: 1, retry: 3 });', ['config']],
      [`vi.setConfig({ testTimeout: ${HANG_GUARD} });`, ['config']],
      ['vi.setConfig({ fakeTimers: {} });', ['config']],
      ['vi.setConfig(cfg);', ['config']],
      ['vi.setConfig({ ...cfg });', ['config']],
      ['vitest.setConfig(cfg);', ['config']],
      ["vi['setConfig'](cfg);", ['config']],
      // aroundEach and aroundAll take a timeout like the other hooks: bare, on a test, with an options object, an opaque one or a spread.
      ['aroundEach(async (run) => { await run(); }, 5000);', ['timeout']],
      ['aroundAll(async (run) => { await run(); }, 5000);', ['timeout']],
      ['test.aroundEach(async (run) => { await run(); }, 5000);', ['timeout']],
      ['slow.aroundAll(async (run) => { await run(); }, 5);', ['timeout']],
      ['aroundEach(async (run) => { await run(); }, { timeout: 5 });', ['timeout']],
      ['aroundAll(fn, opts);', ['opaque']],
      ["const m = await import('vitest'); m.aroundEach(fn, 5);", ['timeout']],
      ["const q = require('vitest'); q.aroundAll(fn, 5);", ['timeout']],
      // A spread argument list hides every slot.
      ["it(...args);", ['opaque']],
      ["test.each([[1]])(...args);", ['opaque']],
      ['beforeEach(...args);', ['opaque']],
      ['aroundEach(...args);', ['opaque']],
      ['v.describe.only(...args);', ['opaque']],
      ["onTestFinished(...args);", ['opaque']],
      ["it('s1', ...rest);", ['opaque']],
      // The timeout slot of onTestFinished and onTestFailed, bare or on the test context.
      ['onTestFinished(() => {}, 5000);', ['timeout']],
      ['onTestFailed(() => {}, { timeout: 5 });', ['timeout']],
      ['onTestFinished(() => {}, opts);', ['opaque']],
      ['ctx.onTestFinished(() => {}, 5);', ['timeout']],
      ['onTestFailed(async () => {}, { ...opts });', ['opaque']],
      // Calls through a namespace import of vitest, however it is loaded.
      ["import * as v from 'vitest'; v.it('n1', () => {}, 5000);", ['timeout']],
      ["v.test('n2', { timeout: 5 }, () => {});", ['timeout']],
      ["v.it.each([[1]])('n3', () => {}, 5);", ['timeout']],
      ["v['it']('n4', { retry: 2 }, () => {});", ['retry']],
      ['v.describe.concurrent("n5", () => {}, 5);', ['timeout']],
      ['v.beforeEach(() => {}, 5);', ['timeout']],
      ['v.aroundEach(async (run) => { await run(); }, 5000);', ['timeout']],
      ['v.aroundAll(async (run) => { await run(); }, { timeout: 5 });', ['timeout']],
      ['v.onTestFinished(() => {}, 5);', ['timeout']],
      ['v.vi.setConfig({ retry: 1 });', ['config']],
      ["const slowV = v.test.extend({}); slowV('n6', () => {}, 5);", ['timeout']],
      ["const w = await import('vitest'); w.it('n7', () => {}, 5);", ['timeout']],
      ["const r = require('vitest'); r.test('n8', () => {}, 5);", ['timeout']],
      ["v.it('n9', () => {}, " + HANG_GUARD + "); v.beforeEach(() => {}); v.vi.fn();", []],
      // Not vitest: a namespace of another module, and a member that only looks like a runner.
      ["import * as z from 'zod'; z.it('p1', () => {}, 5); z.vi.setConfig(cfg); z.beforeEach(() => {}, 5);", []],
      // Allowed: waits and child processes keep their own timeouts, test data may hold one, and the hang guard may be named in any slot.
      ["it('e', async () => { await vi.waitFor(() => {}, { timeout: 1000 }); spawnSync('git', [], { timeout: 5000 }); });", []],
      ["it.each([{ timeout: 3 }])('f', ({ timeout }) => {});", []],
      [`test('g1', { timeout: ${HANG_GUARD} }, () => {});`, []],
      [`it('g2', () => {}, ${HANG_GUARD});`, []],
      [`it('g3', () => {}, { timeout: ${HANG_GUARD} });`, []],
      [`describe('g4', { timeout: ${HANG_GUARD} }, () => {});`, []],
      [`afterAll(async () => {}, ${HANG_GUARD});`, []],
      [`aroundEach(async (run) => { await run(); }, ${HANG_GUARD}); aroundAll(async (run) => { await run(); }); test.aroundEach(fn, { timeout: ${HANG_GUARD} });`, []],
      ['expect(...args); other.aroundEach(fn, 5); fn(...args); Math.max(...nums);', []],
      [`beforeEach(() => {}, { timeout: ${HANG_GUARD} });`, []],
      [`onTestFinished(() => {}, ${HANG_GUARD}); onTestFailed(() => {}, { timeout: ${HANG_GUARD} });`, []],
      ["onTestFinished(() => {}); vi.setConfig; vi.fn(setConfigLater);", []],
      ["it('h', { concurrent: true }, runCase); test('i', runCase); beforeAll(setUp);", []],
      ["const quick = it.extend({}); quick('j', () => {}); /x/.test('y'); pattern.test(path);", []],
    ];
    const source = lines.map(([line]) => line).join('\n');
    const expected = lines.flatMap(([, limits], index) => limits.map((limit) => `x.test.ts:${index + 1} ${LIMITS[limit]}`));
    expect(ownLimits('x.test.ts', source)).toEqual(expected);
  });

  it('finds no test file Vitest runs that sets its own timeout or a retry', async () => {
    // The files Vitest itself collects with Vitest's default include, minus this config's exclude, not a hand-kept list.
    const vitest = await createVitest('test', { root, watch: false });
    let files: string[];
    try {
      files = (await vitest.globTestSpecifications()).map((specification) => relative(root, specification.moduleId));
    } finally { await vitest.close(); }
    expect(files, 'test files found').toEqual(expect.arrayContaining(['src/engine/engine.test.ts', 'scripts/test-budget.test.ts', 'tests/vite-config.test.ts']));
    expect(files.length, 'test files found').toBeGreaterThan(100);
    expect(files.flatMap((file) => ownLimits(file, readFileSync(join(root, file), 'utf8')))).toEqual([]);
  });
});
