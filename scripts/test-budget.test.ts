import { readdirSync, readFileSync } from 'node:fs';
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

/** The hang guard, the one timeout a test file may name. */
const HANG_GUARD = 'HANG_TIMEOUT_MS';
const isHangGuard = (node: ts.Node) => ts.isIdentifier(node) && node.text === HANG_GUARD;

/** The identifier a call chain starts from: `it` for it(...), it.concurrent(...) and it.each(...)(...). */
const rootName = (node: ts.Expression): string | undefined => {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) return rootName(node.expression);
  return undefined;
};

/** A timeout in an argument slot: anything but the test or hook function, or the hang guard. */
const timeoutArgument = (node: ts.Node | undefined) => !!node && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !isHangGuard(node);

/** An options object that sets one of `keys` to anything but the hang guard. */
const timeoutOption = (node: ts.Node | undefined, keys: readonly string[]) =>
  !!node && ts.isObjectLiteralExpression(node) && node.properties.some((property) =>
    ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && keys.includes(property.name.text) && !isHangGuard(property.initializer));

const setsOwnTimeout = (call: ts.CallExpression, sourceFile: ts.SourceFile) => {
  const name = rootName(call.expression);
  const args = call.arguments;
  // it(name, fn, 30_000), it(name, fn, { timeout }) and it(name, { timeout }, fn), also on it.each(...)(...).
  if (name === 'it' || name === 'test') return timeoutArgument(args[2]) || timeoutOption(args[1], ['timeout']);
  // beforeEach(fn, 10_000), only on the hook itself.
  if (['beforeAll', 'beforeEach', 'afterAll', 'afterEach'].includes(call.expression.getText(sourceFile))) return timeoutArgument(args[1]);
  return call.expression.getText(sourceFile) === 'vi.setConfig' && timeoutOption(args[0], ['testTimeout', 'hookTimeout']);
};

/**
 * The lines where `source` gives a test or hook its own timeout. Only the hang guard (HANG_TIMEOUT_MS,
 * set for every test and hook in vite.config.ts) may: a per-test ceiling fails a test on a busy
 * runner rather than on a bug (docs/DEVELOPMENT.md, Test timing).
 */
const ownTimeouts = (file: string, source: string) => {
  const found: string[] = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && setsOwnTimeout(node, sourceFile)) found.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

describe('one timeout for every test', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));

  it('finds a test or hook that sets its own timeout, and nothing else', () => {
    const source = [
      "it('a', async () => {}, 30_000);",
      "test('b', { timeout: 5000 }, () => {});",
      "it.each([[1]])('c %s', async () => {}, 60_000);",
      "it.concurrent('d', () => {}, { timeout: 1 });",
      'beforeEach(() => {}, 10_000);',
      'vi.setConfig({ testTimeout: 1000 });',
      "it('e', async () => { await vi.waitFor(() => {}, { timeout: 1000 }); spawnSync('git', [], { timeout: 5000 }); });",
      "it.each([{ timeout: 3 }])('f', ({ timeout }) => {});",
      `test('g', { timeout: ${HANG_GUARD} }, () => {});`,
      `afterAll(async () => {}, ${HANG_GUARD});`,
      'vi.setConfig({ fakeTimers: {} });',
    ].join('\n');
    expect(ownTimeouts('x.test.ts', source)).toEqual(['x.test.ts:1', 'x.test.ts:2', 'x.test.ts:3', 'x.test.ts:4', 'x.test.ts:5', 'x.test.ts:6']);
  });

  it('finds no test file under src/ or scripts/ that sets its own timeout', () => {
    const files = ['src', 'scripts'].flatMap((dir) => readdirSync(`${root}${dir}`, { recursive: true, encoding: 'utf8' }).filter((path) => /\.test\.tsx?$/.test(path)).map((path) => `${dir}/${path}`));
    expect(files.length, 'test files found').toBeGreaterThan(100);
    expect(files.flatMap((file) => ownTimeouts(file, readFileSync(`${root}${file}`, 'utf8')))).toEqual([]);
  });
});
