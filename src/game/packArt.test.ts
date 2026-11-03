import { beforeEach, describe, expect, it, vi } from 'vitest';

// The module settles once and stays settled, so each test loads its own copy: otherwise whichever
// test runs second sees the art already settled (shuffled order, #1122).
let afterPackArt: typeof import('./packArt').afterPackArt;
let packArtSettled: typeof import('./packArt').packArtSettled;

describe('afterPackArt', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ afterPackArt, packArtSettled } = await import('./packArt'));
  });

  it('holds tasks until the sealed pack art settles, then runs them and any later ones (#776)', async () => {
    const early = vi.fn();
    afterPackArt(early);
    await Promise.resolve();
    expect(early).not.toHaveBeenCalled();

    packArtSettled();
    await Promise.resolve();
    expect(early).toHaveBeenCalledOnce();

    const late = vi.fn();
    afterPackArt(late);
    await Promise.resolve();
    expect(late).toHaveBeenCalledOnce();
    // A second load (the other half's image, a remount) changes nothing.
    packArtSettled();
    await Promise.resolve();
    expect(early).toHaveBeenCalledOnce();
  });

  it('never runs a task that was cancelled before the art settled, and leaves the others alone', async () => {
    const dropped = vi.fn();
    const kept = vi.fn();
    const cancel = afterPackArt(dropped);
    afterPackArt(kept);
    cancel();
    packArtSettled();
    await Promise.resolve();
    expect(dropped).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
  });
});
