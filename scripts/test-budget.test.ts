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
  it.each([[], ['--reporter=dot'], ['--reporter=json', '--coverage.enabled=false']])('keeps the timing reporter and the hang timeout in npm test %j', async (...flags: string[]) => {
    const { options } = parseCLI([...npmTest.split(' '), ...flags]);
    const vitest = await createVitest('test', { ...options, root, watch: false });
    try {
      // createVitest loads the configured reporters, so a bad path would already have thrown.
      expect(vitest.config.reporters.filter((reporter) => Array.isArray(reporter) && reporter[0] === TEST_BUDGET_REPORTER)).toEqual([[TEST_BUDGET_REPORTER, {}]]);
      // A tighter --testTimeout in the script would turn load into failures again.
      expect([vitest.config.testTimeout, vitest.config.hookTimeout]).toEqual([HANG_TIMEOUT_MS, HANG_TIMEOUT_MS]);
    } finally { await vitest.close(); }
  });

  it('applies the hang timeout to targeted runs too', async () => {
    const vitest = await createVitest('test', { root, watch: false });
    try {
      expect([vitest.config.testTimeout, vitest.config.hookTimeout]).toEqual([HANG_TIMEOUT_MS, HANG_TIMEOUT_MS]);
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
const HOOKS = ['beforeAll', 'beforeEach', 'afterAll', 'afterEach'];

/** What the guard reports, each with its own message. Both fail: no test sets its own timeout or retries. */
const LIMITS = { timeout: 'sets its own timeout', retry: 'retries a failure' } as const;
type Limit = keyof typeof LIMITS;

/** The identifier a call chain starts from: `it` for it(...), it.only(...), it.each(...)(...), it.each`...`(...) and it['only'](...). */
const rootName = (node: ts.Expression): string | undefined => {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isTaggedTemplateExpression(node)) return rootName(node.tag);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)
    || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return rootName(node.expression);
  return undefined;
};

/** The name a call ends on: `beforeEach` for beforeEach(...) and test.beforeEach(...). */
const calleeName = (node: ts.Expression) => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined;

/**
 * Vitest's runners plus the names this file gives them: `const slow = test.extend(...)`, chains of
 * those in any order, and `import { it as spec }`.
 */
const runnersIn = (sourceFile: ts.SourceFile) => {
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
      const root = rootName(value);
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

/** What an options object sets: one of `timeoutKeys` as anything but the hang guard (`{ timeout }` included), or any retry. */
const limitsIn = (options: ts.ObjectLiteralExpression, timeoutKeys: readonly string[]) =>
  options.properties.flatMap((property): Limit[] => {
    const key = keyName(property);
    if (key === 'retry') return ['retry'];
    if (key === undefined || !timeoutKeys.includes(key)) return [];
    return ts.isPropertyAssignment(property) && isHangGuard(property.initializer) ? [] : ['timeout'];
  });

/** What a timeout slot holds: nothing for the function or the hang guard, an options object's limits, and anything else (30_000, a variable) is a timeout. */
const limitsOf = (node: ts.Expression | undefined): Limit[] => {
  if (!node || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || isHangGuard(node)) return [];
  return ts.isObjectLiteralExpression(node) ? limitsIn(node, ['timeout']) : ['timeout'];
};

const limitsOfCall = (call: ts.CallExpression, runners: ReadonlySet<string>): Limit[] => {
  const root = rootName(call.expression);
  const callee = calleeName(call.expression);
  const args = call.arguments;
  // beforeEach(fn, 10_000) and beforeEach(fn, { timeout }), bare or on a test: test.beforeEach(...).
  if (callee !== undefined && HOOKS.includes(callee) && (ts.isIdentifier(call.expression) || (root !== undefined && runners.has(root)))) return limitsOf(args[1]);
  // vi.setConfig({ testTimeout, hookTimeout, retry }).
  if (callee === 'setConfig' && (root === 'vi' || root === 'vitest')) return args[0] && ts.isObjectLiteralExpression(args[0]) ? limitsIn(args[0], ['testTimeout', 'hookTimeout']) : [];
  if (root === undefined || !runners.has(root)) return [];
  // it(name, options, fn), and the same for test, describe, suite, their chains (it.each(...)(...),
  // it.each`...`(...), describe.concurrent(...)) and aliases: the function is the third argument.
  if (args[1] && ts.isObjectLiteralExpression(args[1])) return limitsIn(args[1], ['timeout']);
  // it(name, fn, 30_000) and it(name, fn, options).
  return limitsOf(args[2]);
};

/**
 * Where `source` gives a test, suite or hook its own timeout, or a retry, as `file:line message`.
 * Only the hang guard (HANG_TIMEOUT_MS, set for every test and hook in vite.config.ts) may be named:
 * a per-test ceiling fails a test on a busy runner rather than on a bug, and a retry hides a flake
 * (docs/DEVELOPMENT.md, Test timing).
 */
const ownLimits = (file: string, source: string) => {
  const found: string[] = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const runners = runnersIn(sourceFile);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      for (const limit of new Set(limitsOfCall(node, runners))) found.push(`${file}:${line} ${LIMITS[limit]}`);
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
      ['vi.setConfig({ testTimeout: 1000 });', ['timeout']],
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
      ['vi.setConfig({ hookTimeout: 1, retry: 3 });', ['timeout', 'retry']],
      // Allowed: waits and child processes keep their own timeouts, test data may hold one, and the hang guard may be named in any slot.
      ["it('e', async () => { await vi.waitFor(() => {}, { timeout: 1000 }); spawnSync('git', [], { timeout: 5000 }); });", []],
      ["it.each([{ timeout: 3 }])('f', ({ timeout }) => {});", []],
      [`test('g1', { timeout: ${HANG_GUARD} }, () => {});`, []],
      [`it('g2', () => {}, ${HANG_GUARD});`, []],
      [`it('g3', () => {}, { timeout: ${HANG_GUARD} });`, []],
      [`describe('g4', { timeout: ${HANG_GUARD} }, () => {});`, []],
      [`afterAll(async () => {}, ${HANG_GUARD});`, []],
      [`beforeEach(() => {}, { timeout: ${HANG_GUARD} });`, []],
      [`vi.setConfig({ testTimeout: ${HANG_GUARD}, hookTimeout: ${HANG_GUARD} });`, []],
      ['vi.setConfig({ fakeTimers: {} });', []],
      ["it('h', { concurrent: true }, runCase); test('i', runCase); beforeAll(setUp);", []],
      ["const quick = it.extend({}); quick('j', () => {}); /x/.test('y'); pattern.test(path);", []],
    ];
    const source = lines.map(([line]) => line).join('\n');
    const expected = lines.flatMap(([, limits], index) => limits.map((limit) => `x.test.ts:${index + 1} ${LIMITS[limit]}`));
    expect(ownLimits('x.test.ts', source)).toEqual(expected);
  });

  it('finds no test file Vitest runs that sets its own timeout or a retry', async () => {
    // The files Vitest itself collects with this config's include and exclude, not a hand-kept list.
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
