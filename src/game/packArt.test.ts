import { describe, expect, it, vi } from 'vitest';
import { afterPackArt, packArtSettled } from './packArt';

describe('afterPackArt', () => {
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
});
