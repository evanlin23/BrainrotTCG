// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from './idle';

vi.mock('../assets/images/card_back.webp', () => ({ default: '/card_back.webp' }));

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

const show = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('whenIdle', () => {
  it('waits for the browser to be idle, and can be cancelled', () => {
    const idle = new Map<number, () => void>();
    const cancel = vi.fn((handle: number) => idle.delete(handle));
    vi.stubGlobal('requestIdleCallback', (task: () => void, { timeout }: { timeout: number }) => {
      expect(timeout).toBe(2000);
      idle.set(idle.size + 1, task);
      return idle.size;
    });
    vi.stubGlobal('cancelIdleCallback', cancel);
    const task = vi.fn();
    whenIdle(task);
    expect(task).not.toHaveBeenCalled();
    idle.get(1)!();
    expect(task).toHaveBeenCalledOnce();

    const stop = whenIdle(task);
    stop();
    expect(cancel).toHaveBeenCalledWith(2);
  });

  it('falls back to a short timer where requestIdleCallback is missing (Safari)', () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    const task = vi.fn();
    whenIdle(task);
    vi.advanceTimersByTime(199);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledOnce();

    const later = vi.fn();
    whenIdle(later)();
    vi.advanceTimersByTime(1000);
    expect(later).not.toHaveBeenCalled();
  });
});

describe('warmUpFirstPack', () => {
  const fetched = () => {
    const images: { src: string }[] = [];
    vi.stubGlobal('Image', class { src = ''; constructor() { images.push(this); } });
    vi.stubGlobal('requestIdleCallback', undefined);
    return () => images.map((image) => image.src);
  };

  // Each test starts before the sealed pack's art has loaded; load() is it loading.
  let load: () => Promise<void>;
  beforeEach(async () => {
    vi.resetModules();
    const { packArtSettled } = await import('./packArt');
    load = async () => {
      packArtSettled();
      await Promise.resolve();
    };
  });

  it("waits for the sealed pack's art first, however idle the page is (#776)", async () => {
    const images = fetched();
    const { warmUpFirstPack } = await import('./warmUp');
    warmUpFirstPack();
    vi.runAllTimers();
    expect(images()).toEqual([]);
    await load();
    expect(images()).toEqual([]);
    vi.runAllTimers();
    expect(images()).toEqual(['/card_back.webp']);
  });

  it('runs any task the same way: after the pack art settles and the page is idle, once', async () => {
    fetched();
    const { warmUpForPack } = await import('./warmUp');
    const task = vi.fn();
    warmUpForPack(task);
    vi.runAllTimers();
    expect(task).not.toHaveBeenCalled();
    await load();
    expect(task).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(task).toHaveBeenCalledOnce();
  });

  it('fetches the card back once the page is idle, not before', async () => {
    const images = fetched();
    const { warmUpFirstPack } = await import('./warmUp');
    warmUpFirstPack();
    await load();
    expect(images()).toEqual([]);
    vi.runAllTimers();
    expect(images()).toEqual(['/card_back.webp']);
  });

  it('runs what the caller also warms with the card back, and not before', async () => {
    const images = fetched();
    const alsoWarm = vi.fn();
    const { warmUpFirstPack } = await import('./warmUp');
    warmUpFirstPack(alsoWarm);
    await load();
    expect(alsoWarm).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(images()).toEqual(['/card_back.webp']);
    expect(alsoWarm).toHaveBeenCalledOnce();
  });

  it('waits while the tab is hidden, and starts once it is shown', async () => {
    const images = fetched();
    const { warmUpFirstPack } = await import('./warmUp');
    visibility = 'hidden';
    warmUpFirstPack();
    await load();
    vi.advanceTimersByTime(60_000);
    expect(images()).toEqual([]);
    show('visible');
    vi.runAllTimers();
    expect(images()).toEqual(['/card_back.webp']);
  });

  it('waits again if the tab is hidden before the page goes idle', async () => {
    const images = fetched();
    const { warmUpFirstPack } = await import('./warmUp');
    warmUpFirstPack();
    await load();
    visibility = 'hidden';
    vi.runAllTimers();
    expect(images()).toEqual([]);
    show('visible');
    vi.runAllTimers();
    expect(images()).toEqual(['/card_back.webp']);
  });

  it('fetches nothing when the visitor saves data', async () => {
    const images = fetched();
    vi.stubGlobal('navigator', { ...navigator, connection: { saveData: true } });
    const alsoWarm = vi.fn();
    const { warmUpFirstPack } = await import('./warmUp');
    warmUpFirstPack(alsoWarm);
    await load();
    vi.runAllTimers();
    expect(images()).toEqual([]);
    expect(alsoWarm).not.toHaveBeenCalled();
  });

  it.each(['#/cards', '#/rankings', '#/profile', '#/settings', '#/pull/abc', '#/profile/abc'])(
    'fetches nothing on %s, which opens no pack',
    async (hash) => {
      const images = fetched();
      history.replaceState(null, '', `/${hash}`);
      const { warmUpFirstPack } = await import('./warmUp');
      warmUpFirstPack();
      await load();
      vi.runAllTimers();
      expect(images()).toEqual([]);
    },
  );
});

describe('warmUpArgon2 (#776)', () => {
  // The Argon2 chunk is a dynamic import; each evaluation of its module is one fetch.
  const fetches: number[] = [];
  let artLoaded: () => void;
  beforeEach(async () => {
    fetches.length = 0;
    vi.resetModules();
    vi.doMock('../engine/argon2', () => {
      fetches.push(1);
      return { argon2id: vi.fn() };
    });
    vi.stubGlobal('requestIdleCallback', undefined);
    artLoaded = (await import('./packArt')).packArtSettled;
  });
  afterEach(() => vi.doUnmock('../engine/argon2'));

  const idle = async () => {
    vi.runAllTimers();
    await vi.dynamicImportSettled();
  };

  it("waits for the sealed pack's art on a page that can open a pack, then fetches it once idle", async () => {
    const { warmUpArgon2 } = await import('./warmUp');
    warmUpArgon2();
    await idle();
    expect(fetches).toEqual([]);
    artLoaded();
    await Promise.resolve();
    expect(fetches).toEqual([]);
    await idle();
    expect(fetches).toEqual([1]);
  });

  it.each(['#/cards', '#/rankings', '#/profile', '#/settings', '#/pull/abc', '#/profile/abc'])(
    'fetches it on %s, which opens no pack and so never shows sealed art',
    async (hash) => {
      history.replaceState(null, '', `/${hash}`);
      const { warmUpArgon2 } = await import('./warmUp');
      warmUpArgon2();
      await idle();
      expect(fetches).toEqual([1]);
    },
  );

  it('fetches it when the visitor saves data, which skips the card back', async () => {
    vi.stubGlobal('navigator', { ...navigator, connection: { saveData: true } });
    const { warmUpArgon2 } = await import('./warmUp');
    warmUpArgon2();
    artLoaded();
    await Promise.resolve();
    await idle();
    expect(fetches).toEqual([1]);
  });

  it('ignores a fetch that fails', async () => {
    vi.doMock('../engine/argon2', () => { throw new Error('Failed to fetch dynamically imported module'); });
    const { warmUpArgon2 } = await import('./warmUp');
    warmUpArgon2();
    artLoaded();
    await Promise.resolve();
    // An unhandled rejection from the import would fail the run.
    await idle();
  });
});
