// The default that src/test/isolation.ts puts on jsdom's HTMLMediaElement.prototype.play before each
// test, and the check it runs after. A plain module (not a setup file) so isolation.test.ts can test
// the decision directly; the wiring is in isolation.ts.
import type { MockInstance } from 'vitest';

export const UNSTUBBED_PLAY =
  'HTMLMediaElement.play() was called without a stub. jsdom\'s play() returns undefined, not a Promise. ' +
  'A test that starts a sound stubs play() itself: vi.spyOn(HTMLMediaElement.prototype, \'play\').mockResolvedValue(). ' +
  'See docs/DEVELOPMENT.md, Test isolation.';

export class UnstubbedPlayError extends Error {
  constructor() {
    super(UNSTUBBED_PLAY);
    this.name = 'UnstubbedPlayError';
  }
}

/** The default implementation: throws, naming the rule. */
export const unstubbedPlay = (): never => {
  throw new UnstubbedPlayError();
};

/**
 * Calls that reached the default. Counted from the spy's recorded results, so a call a test's own stub
 * answered (`mockResolvedValue`, `mockImplementation`, or a `*Once` value) is not one, and the test
 * acknowledges a deliberate unstubbed call with `mockClear()`.
 */
export const unstubbedPlayCalls = (guard: Pick<MockInstance, 'mock'>): number =>
  guard.mock.results.filter(result => result.type === 'throw' && result.value instanceof UnstubbedPlayError).length;

/**
 * Throws when a call reached the default. App code can swallow the default's own throw (an event handler,
 * an effect), so this is what fails the test. Call it before restoring spies, which drops the results.
 */
export const assertNoUnstubbedPlay = (guard: Pick<MockInstance, 'mock'> | undefined): void => {
  const calls = guard ? unstubbedPlayCalls(guard) : 0;
  if (calls > 0) throw new Error(`${calls} unstubbed call(s). ${UNSTUBBED_PLAY}`);
};
