import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from './idle';

const warmUpMiner = vi.hoisted(() => vi.fn());
vi.mock('./ticketMiner', () => ({ warmUpMiner }));
vi.mock('../assets/images/card_back.webp', () => ({ default: '/card_back.webp' }));

beforeEach(() => {
  vi.useFakeTimers();
  warmUpMiner.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
  it('warms the miner and fetches the card back once the page is idle, not before', async () => {
    const images: { src: string }[] = [];
    vi.stubGlobal('Image', class { src = ''; constructor() { images.push(this); } });
    vi.stubGlobal('requestIdleCallback', undefined);
    const { warmUpFirstPack } = await import('./warmUp');
    warmUpFirstPack();
    expect(warmUpMiner).not.toHaveBeenCalled();
    expect(images).toEqual([]);
    vi.runAllTimers();
    expect(warmUpMiner).toHaveBeenCalledOnce();
    expect(images.map((image) => image.src)).toEqual(['/card_back.webp']);
  });
});
