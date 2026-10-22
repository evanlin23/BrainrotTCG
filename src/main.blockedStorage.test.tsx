// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

// main.tsx with the real runMigrations: only the steps that need more than storage are left out.
vi.mock('./game/move', () => ({ receiveSave: () => Promise.resolve(false) }));
vi.mock('./game/history', () => ({ migratePullLog: vi.fn() }));
vi.mock('./game/profiles', () => ({ resumeReopening: vi.fn() }));
vi.mock('./game/warmUp', () => ({ warmUpFirstPack: vi.fn() }));
vi.mock('./App', () => ({ default: () => <p data-testid="app">The game</p> }));

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('starts the game when this browser blocks storage entirely', async () => {
  const blocked = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
  vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked, key: blocked, length: 0 });
  document.body.innerHTML = '<div id="root"></div>';

  await import('./main');

  await vi.waitFor(() => expect(document.querySelector('[data-testid="app"]')).not.toBeNull());
  expect(document.querySelector('main.app-crash')).toBeNull();
}, 30_000); // Loads the real card registry.
