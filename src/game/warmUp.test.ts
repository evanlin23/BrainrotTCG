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

  it('fetches the card back once the page is idle, not before', async () => {
    const images = fetched();
    const { warmUpFirstPack } = await import('./warmUp');
    warmUpFirstPack();
    expect(images()).toEqual([]);
    vi.runAllTimers();
    expect(images()).toEqual(['/card_back.webp']);
  });

  it('waits while the tab is hidden, and starts once it is shown', async () => {
    const images = fetched();
    const { warmUpFirstPack } = await import('./warmUp');
    visibility = 'hidden';
    warmUpFirstPack();
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
    const { warmUpFirstPack } = await import('./warmUp');
    warmUpFirstPack();
    vi.runAllTimers();
    expect(images()).toEqual([]);
  });

  it.each(['#/cards', '#/rankings', '#/profile', '#/settings', '#/pull/abc', '#/profile/abc'])(
    'fetches nothing on %s, which opens no pack',
    async (hash) => {
      const images = fetched();
      history.replaceState(null, '', `/${hash}`);
      const { warmUpFirstPack } = await import('./warmUp');
      warmUpFirstPack();
      vi.runAllTimers();
      expect(images()).toEqual([]);
    },
  );
});
