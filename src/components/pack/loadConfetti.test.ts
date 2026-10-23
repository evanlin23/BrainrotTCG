// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../../constants';
import { setStoredData } from '../../utils/storage';
import { DEFAULT_SETTINGS } from '../../utils/settings';

// The confetti chunk is a dynamic import; each evaluation of its module is one fetch.
const fetches: number[] = [];
let fails = false;
const chunk = () => {
  fetches.push(1);
  if (fails) throw new Error('Failed to fetch dynamically imported module');
  return { triggerRarityConfetti: () => {}, triggerHoloSparkles: () => {} };
};

const warm = async (motion?: 'reduced') => {
  vi.resetModules();
  // A mock's module is cached once built, so each fetch registers it again.
  vi.doMock('./confettiEffects', chunk);
  // The Motion setting lives in a module of its own, so it is set on the copy this load uses.
  if (motion) (await import('../../utils/motion')).setMotionSetting(motion);
  const { warmConfetti } = await import('./loadConfetti');
  warmConfetti();
  await vi.dynamicImportSettled();
};

beforeEach(() => {
  fetches.length = 0;
  fails = false;
  localStorage.clear();
});

afterEach(() => {
  vi.doUnmock('./confettiEffects');
  vi.unstubAllGlobals();
});

describe('warmConfetti (#776)', () => {
  it('fetches the library for a player whose particles are on and whose device allows motion', async () => {
    await warm();
    expect(fetches).toEqual([1]);
  });

  it('fetches nothing when particles are off, since nothing would burst', async () => {
    setStoredData(STORAGE_KEYS.SETTINGS, { ...DEFAULT_SETTINGS, particlesEnabled: false });
    await warm();
    expect(fetches).toEqual([]);
  });

  it('fetches nothing when the device asks for less motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: /reduce/.test(query), addEventListener() {}, removeEventListener() {} }));
    await warm();
    expect(fetches).toEqual([]);
  });

  it("fetches nothing when the Motion setting is reduced, whatever the device says", async () => {
    await warm('reduced');
    expect(fetches).toEqual([]);
  });

  it('ignores a fetch that fails', async () => {
    fails = true;
    // An unhandled rejection from the import would fail the run.
    await warm();
    expect(fetches).toEqual([1]);
  });
});
