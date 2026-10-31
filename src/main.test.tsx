// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The startup steps main.tsx runs, with the real work (storage, IndexedDB, the engine) left out. */
const startup = vi.hoisted(() => ({
  receiveSave: vi.fn<() => Promise<boolean>>(),
  runMigrations: vi.fn(() => true),
  migratePullLog: vi.fn(),
  resumeReopening: vi.fn(),
  warmUpFirstPack: vi.fn(),
  warmUpArgon2: vi.fn(),
}));

vi.mock('./game/move', () => ({ receiveSave: startup.receiveSave }));
vi.mock('./utils/migrations', () => ({ runMigrations: startup.runMigrations }));
vi.mock('./game/history', () => ({ migratePullLog: startup.migratePullLog }));
vi.mock('./game/reopenJob', () => ({ resumeReopening: startup.resumeReopening }));
vi.mock('./game/warmUp', () => ({ warmUpFirstPack: startup.warmUpFirstPack, warmUpArgon2: startup.warmUpArgon2 }));
vi.mock('./App', () => ({ default: () => <p data-testid="app">The game</p> }));

const HANDOVER_FAILED = expect.stringContaining('Bringing the save over failed');
const app = () => document.querySelector('[data-testid="app"]');
const crash = () => document.querySelector('main.app-crash');

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // vi.clearAllMocks() does not clear mockImplementation or mockReturnValue; reset startup mocks
  // so tests mutating their behavior don't poison other tests under --sequence.shuffle.
  startup.receiveSave.mockReset();
  startup.runMigrations.mockReset().mockReturnValue(true);
  startup.migratePullLog.mockReset();
  startup.resumeReopening.mockReset();
  startup.warmUpFirstPack.mockReset();
  startup.warmUpArgon2.mockReset();
  document.body.innerHTML = '<div id="root"></div>';
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  document.body.innerHTML = '';
});

/** A fresh run of main.tsx, as a page load would be. */
const load = () => import('./main');

describe('starting the game when the save hand-over fails', () => {
  const failures = {
    'rejects': () => Promise.reject(new Error('hand-over rejected')),
    'throws before it returns': () => {
      throw new Error('hand-over threw');
    },
  };

  it.each(Object.entries(failures))('still starts the game, and says why, when the hand-over %s', async (_name, fail) => {
    startup.receiveSave.mockImplementation(fail);
    await load();

    await vi.waitFor(() => expect(app()).not.toBeNull());
    expect(errors).toHaveBeenCalledWith(HANDOVER_FAILED, expect.any(Error));
    // The startup steps ran as they do for any other page load.
    expect(startup.runMigrations).toHaveBeenCalledTimes(1);
    expect(startup.migratePullLog).toHaveBeenCalledTimes(1);
    expect(startup.resumeReopening).toHaveBeenCalledTimes(1);
    expect(startup.warmUpFirstPack).toHaveBeenCalledTimes(1);
    expect(startup.warmUpArgon2).toHaveBeenCalledTimes(1);
  });

  it('starts the game without a word when there was no hand-over to make', async () => {
    startup.receiveSave.mockResolvedValue(false);
    await load();

    await vi.waitFor(() => expect(app()).not.toBeNull());
    expect(errors).not.toHaveBeenCalledWith(HANDOVER_FAILED, expect.anything());
  });

  it('leaves the game unstarted in the window that received a save', async () => {
    let finishHandOver: (received: boolean) => void = () => {};
    startup.receiveSave.mockReturnValue(new Promise<boolean>((resolve) => { finishHandOver = resolve; }));
    await load();

    await vi.waitFor(() => expect(startup.receiveSave).toHaveBeenCalledTimes(1));
    finishHandOver(true);
    // main.tsx's steps after the hand-over are a chain of promise callbacks (no timers or I/O), so they have
    // all run by the next macrotask. Only then can "nothing started" be checked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app()).toBeNull();
    expect(startup.runMigrations).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('startup migration failure containment (#660, #659)', () => {
  it('renders crash fallback and halts before mounting ordinary app when runMigrations throws', async () => {
    startup.receiveSave.mockResolvedValue(false);
    startup.runMigrations.mockImplementation(() => {
      throw new TypeError("Cannot read properties of null (reading 'id')");
    });
    await load();

    await vi.waitFor(() => expect(crash()).not.toBeNull());
    expect(app()).toBeNull();
    expect(document.getElementById('root')!.children).toHaveLength(1);
    expect(crash()!.querySelector('h1')?.textContent).toBe('Something went wrong');
    expect(crash()!.querySelector('button')?.textContent).toBe('Reload');

    // Does not advance to game setup
    expect(startup.resumeReopening).not.toHaveBeenCalled();
    expect(startup.warmUpFirstPack).not.toHaveBeenCalled();
    expect(startup.warmUpArgon2).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(
      'App startup failed before mount',
      expect.any(TypeError),
    );
  });

  it('offers the save as a file, not a reload, when saved data could not be upgraded', async () => {
    startup.receiveSave.mockResolvedValue(false);
    startup.runMigrations.mockReturnValue(false);
    await load();

    await vi.waitFor(() => expect(crash()).not.toBeNull());
    expect(app()).toBeNull();
    expect(crash()!.querySelector('h1')?.textContent).toBe('Your save needs room to update');
    expect(crash()!.textContent).toContain("Reloading alone won't fix it.");
    expect([...crash()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Download save data', 'Reload']);
    expect(startup.migratePullLog).not.toHaveBeenCalled();
    expect(document.getElementById('root')!.children).toHaveLength(1);
    expect(startup.resumeReopening).not.toHaveBeenCalled();
    expect(startup.warmUpFirstPack).not.toHaveBeenCalled();
    expect(startup.warmUpArgon2).not.toHaveBeenCalled();
  });

  it('renders crash fallback when migratePullLog throws', async () => {
    startup.receiveSave.mockResolvedValue(false);
    startup.runMigrations.mockReturnValue(true);
    startup.migratePullLog.mockImplementation(() => {
      throw new Error('history pull log corrupt');
    });
    await load();

    await vi.waitFor(() => expect(crash()).not.toBeNull());
    expect(app()).toBeNull();
    expect(startup.resumeReopening).not.toHaveBeenCalled();
    expect(startup.warmUpFirstPack).not.toHaveBeenCalled();
    expect(startup.warmUpArgon2).not.toHaveBeenCalled();
  });
});
