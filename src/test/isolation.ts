// The one test-isolation convention (docs/DEVELOPMENT.md, Test isolation), registered for every test
// file by `setupFiles` in vite.config.ts. A file does not repeat these resets; it only adds the ones
// for state of its own. Hooks run in a stack, so a file's own afterEach runs before these.
import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import { assertNoUnstubbedPlay, unstubbedPlay } from './unstubbedPlay';

/** Where every jsdom test starts and ends: the app's address, as mountedApp.ts starts its mounts. */
const START_ADDRESS = '/BrainrotTCG/';

// replaceState neither adds a history entry nor fires hashchange or popstate, so resetting is silent.
const resetAddress = () => {
  if (typeof history !== 'undefined') history.replaceState(null, '', START_ADDRESS);
};

resetAddress();

// jsdom's HTMLMediaElement.play() returns undefined, not a Promise, so app code's `play().catch(...)` throws
// a TypeError that an event handler or effect can swallow. A test that starts a sound stubs play()
// itself; one that doesn't reaches the default from unstubbedPlay.ts, which throws a message naming the
// rule and, because that throw can be swallowed too, fails the test in afterEach. A test's own
// spyOn(...).mockResolvedValue() (or mockImplementation, or a *Once value) answers instead and wins.
// Limits: no guard in a node-environment file, nor when a test or beforeAll already put a mock on play();
// and a vi.resetAllMocks() or vi.restoreAllMocks() in a test body, or in a file afterEach that runs
// before this one, takes the guard off for the rest of that test.
let playGuard: MockInstance | undefined;

beforeEach(() => {
  resetAddress();
  playGuard = undefined;
  if (typeof HTMLMediaElement === 'undefined' || vi.isMockFunction(HTMLMediaElement.prototype.play)) return;
  playGuard = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(unstubbedPlay);
});

afterEach(() => {
  try {
    // Before the restore below, which drops the recorded calls.
    assertNoUnstubbedPlay(playGuard);
  } finally {
    playGuard = undefined;
    // Spies, including those on jsdom prototypes (HTMLMediaElement play, load, pause), go back to jsdom's own.
    vi.restoreAllMocks();
    // A queued `*Once` value or a call history on a module-level vi.fn() would answer the next test.
    vi.resetAllMocks();
    resetAddress();
  }
});
