// The one test-isolation convention (docs/DEVELOPMENT.md, Test isolation), registered for every test
// file by `setupFiles` in vite.config.ts. A file does not repeat these resets; it only adds the ones
// for state of its own. Hooks run in a stack, so a file's own afterEach runs before these.
import { afterEach, beforeEach, vi } from 'vitest';

/** Where every jsdom test starts and ends: the app's address, as mountedApp.ts starts its mounts. */
const START_ADDRESS = '/BrainrotTCG/';

// replaceState neither adds a history entry nor fires hashchange or popstate, so resetting is silent.
const resetAddress = () => {
  if (typeof history !== 'undefined') history.replaceState(null, '', START_ADDRESS);
};

resetAddress();

beforeEach(resetAddress);

afterEach(() => {
  // Spies, including those on jsdom prototypes (HTMLMediaElement play, load, pause), go back to jsdom's own.
  vi.restoreAllMocks();
  // A queued `*Once` value or a call history on a module-level vi.fn() would answer the next test.
  vi.resetAllMocks();
  resetAddress();
});
