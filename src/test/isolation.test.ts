// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { assertNoUnstubbedPlay } from './unstubbedPlay';

// The guard for src/test/isolation.ts (not imported here: importing it would register its hooks in this file). Each pair leaves state behind in its first test and expects the
// second to start clean, so removing the setup file (or one of its resets) fails the second test.
// `shuffle: false` keeps a pair in order under --sequence.shuffle; a reversed pair would test nothing.
const queued = vi.fn<() => string | undefined>();

let entriesAfterLeak = 0;

describe('address', { shuffle: false }, () => {
  it('starts at the app address (jsdom itself starts at /), then leaves a fragment, a path and a history entry behind', () => {
    expect(location.pathname + location.search + location.hash).toBe('/BrainrotTCG/');
    history.pushState(null, '', '/BrainrotTCG/#/somewhere');
    history.replaceState(null, '', '/BrainrotTCG/profile#/pull/leaked');
    entriesAfterLeak = history.length;
  });

  it('is back at the app address, with no fragment and no history entry added by the reset', () => {
    expect(location.pathname + location.search + location.hash).toBe('/BrainrotTCG/');
    expect(history.length).toBe(entriesAfterLeak);
  });
});

describe('jsdom prototype spies', { shuffle: false }, () => {
  it('leaves play() stubbed', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    expect(vi.isMockFunction(HTMLMediaElement.prototype.play)).toBe(true);
  });

  it('starts with jsdom\'s own load and the unstubbed-play default, not the previous test\'s stub', () => {
    expect(vi.isMockFunction(HTMLMediaElement.prototype.load)).toBe(false);
    // The stub from the test above is gone: play() is back to the default that throws, not a resolved Promise.
    expect(() => new Audio().play()).toThrow(/without a stub/);
    vi.mocked(HTMLMediaElement.prototype.play).mockClear(); // deliberate call: acknowledged, so afterEach does not fail it
  });
});

describe('unstubbed play()', () => {
  const guard = () => vi.mocked(HTMLMediaElement.prototype.play);
  // What an event handler or effect does with the default's throw.
  const swallowedPlay = () => {
    try {
      new Audio().play();
    } catch {
      /* swallowed */
    }
  };

  it('throws a message naming the rule', () => {
    expect(() => new Audio().play()).toThrow(/play\(\) was called without a stub.*returns undefined.*stubs play\(\) itself.*Test isolation/s);
    guard().mockClear();
  });

  it('fails the test for a call that app code swallowed, until the test acknowledges it', () => {
    expect(() => assertNoUnstubbedPlay(guard())).not.toThrow();
    swallowedPlay();
    expect(() => assertNoUnstubbedPlay(guard())).toThrow(/1 unstubbed call\(s\).*without a stub/s);
    swallowedPlay();
    expect(() => assertNoUnstubbedPlay(guard())).toThrow(/2 unstubbed call\(s\)/);
    guard().mockClear();
    expect(() => assertNoUnstubbedPlay(guard())).not.toThrow();
  });

  it('counts a call after a *Once stub is used up, not the one the stub answered', async () => {
    guard().mockResolvedValueOnce();
    await new Audio().play();
    expect(() => assertNoUnstubbedPlay(guard())).not.toThrow();
    swallowedPlay();
    expect(() => assertNoUnstubbedPlay(guard())).toThrow(/1 unstubbed call\(s\)/);
    guard().mockClear();
  });

  it('lets a test\'s own stub win, and its calls are not failures', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    await new Audio().play();
    expect(play).toHaveBeenCalledTimes(1);
    expect(() => assertNoUnstubbedPlay(play)).not.toThrow();
  });

  it('checks nothing when no guard was installed', () => {
    expect(() => assertNoUnstubbedPlay(undefined)).not.toThrow();
  });

  it('is wired into the setup: armed before each test, checked before the restore in afterEach', () => {
    const setup = import.meta.glob('./isolation.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    const source = Object.values(setup)[0] ?? '';
    expect(source).toMatch(/beforeEach\([\s\S]*playGuard = vi\.spyOn\(HTMLMediaElement\.prototype, 'play'\)\.mockImplementation\(unstubbedPlay\)/);
    expect(source).toMatch(/afterEach\(\(\) => \{\s*try \{[^}]*assertNoUnstubbedPlay\(playGuard\);[^}]*\} finally \{[\s\S]*vi\.restoreAllMocks\(\)/);
  });
});

describe('module-level mocks', { shuffle: false }, () => {
  it('leaves a queued once-value and a call behind', () => {
    queued.mockReturnValueOnce('leaked');
    expect(queued()).toBe('leaked');
    queued.mockReturnValueOnce('never consumed');
    expect(queued.mock.calls).toHaveLength(1);
  });

  it('starts with no queued value and no recorded call', () => {
    expect(queued.mock.calls).toHaveLength(0);
    expect(queued()).toBeUndefined();
  });
});

describe('per-file resets', () => {
  // A hook whose whole body is mock resets the setup already does after every test. (A reset in a
  // beforeEach, in a test body or beside other teardown is a different thing and is not flagged.)
  const redundantHook = /\bafterEach\(\s*(?:async\s*)?\(\)\s*=>\s*(?:\{\s*(?:vi\.(?:restore|reset|clear)AllMocks\(\);\s*)+\}|vi\.(?:restore|reset|clear)AllMocks\(\))\s*\)/;

  it('no test file keeps an afterEach that only repeats them', () => {
    const files = import.meta.glob(['../**/*.test.{ts,tsx}', '../../scripts/**/*.test.ts', '!./isolation.test.ts'], { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(100);
    expect(Object.entries(files).filter(([, source]) => redundantHook.test(source)).map(([path]) => path)).toEqual([]);
  });
});

describe('prototype assignment', () => {
  // `HTMLCanvasElement.prototype.getContext = vi.fn()` stays on the prototype for every later test in the
  // file, and vi.restoreAllMocks() can't put it back; vi.spyOn restores, and Object.defineProperty (for a
  // method jsdom lacks) is deleted by the file's afterEach. Caught: `=`, `||=`, `&&=` and `??=` onto
  // `.prototype.name` or `.prototype['name']`, through a cast or a `window.` prefix, on any line (a one-line
  // hook included). Not caught: Object.assign and Reflect.set onto a prototype, a prototype held in
  // a variable, an `<any>X.prototype` cast, and an `=` on the line after the property. A comment line is skipped.
  const assignment = /\.prototype(?:\s+as\s+[^;\n]*?\))?(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]*\])\s*(?:\|\||&&|\?\?)?(?<![=!<>])=(?![=>])/;
  const assignsOntoPrototype = (source: string) =>
    source.split('\n').some((line) => !/^\s*(?:\/\/|\/?\*)/.test(line) && assignment.test(line));

  it('flags an assignment onto a prototype in each form, not a spy, a defineProperty or a comparison', () => {
    for (const leak of [
      '    HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx);',
      'Element.prototype.scrollIntoView = scroll;',
      '(HTMLCanvasElement.prototype as any).getContext = vi.fn();',
      '(HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = vi.fn();',
      '(HTMLCanvasElement.prototype as unknown as Record<string, unknown>).toBlob = vi.fn(() => undefined);',
      'window.Element.prototype.scrollIntoView = scroll;',
      "Element.prototype['scrollIntoView'] = scroll;",
      '(Element.prototype as any)["scrollIntoView"] = scroll;',
      'Element.prototype.scrollIntoView ||= scroll;',
      'Element.prototype.scrollIntoView &&= scroll;',
      'Element.prototype.scrollIntoView ??= scroll;',
      'beforeEach(() => { Element.prototype.scrollIntoView = scroll; });',
      'Storage.prototype.setItem = realSetItem;',
    ]) expect(assignsOntoPrototype(leak), leak).toBe(true);
    for (const fine of [
      "vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);",
      "vi.spyOn(HTMLCanvasElement.prototype as unknown as Record<string, unknown>, 'getContext');",
      "Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll });",
      "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });",
      'expect(Element.prototype.scrollIntoView === scroll).toBe(true);',
      'expect(Element.prototype.scrollIntoView).not.toBe(scroll);',
      'const real = Storage.prototype.setItem;',
      '// HTMLCanvasElement.prototype.getContext = vi.fn() leaks',
      ' * Element.prototype.scrollIntoView = scroll',
    ]) expect(assignsOntoPrototype(fine), fine).toBe(false);
  });

  it('no test file assigns onto a prototype', () => {
    const files = import.meta.glob(['../**/*.test.{ts,tsx}', '../../scripts/**/*.test.ts', '!./isolation.test.ts'], { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(100);
    expect(Object.entries(files).filter(([, source]) => assignsOntoPrototype(source)).map(([path]) => path)).toEqual([]);
  });
});
