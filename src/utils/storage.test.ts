import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStoredData } from './storage';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('setStoredData outcome', () => {
  it('reports success while preserving the existing key and JSON format', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    const value = { packsOpened: 1, holoCards: { 'genesis/test': true } };
    expect(setStoredData('brainrot-stats-v1', value)).toBe(true);
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith('brainrot-stats-v1', JSON.stringify(value));
  });

  it.each(['QuotaExceededError', 'SecurityError'])('contains %s and reports an unsuccessful write', (name) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('localStorage', { setItem: () => { throw new DOMException('Denied', name); } });
    expect(setStoredData('brainrot-stats-v1', { packsOpened: 1 })).toBe(false);
  });

  it('contains serialization failure before calling storage', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(setStoredData('test', { value: 1n })).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });
});
