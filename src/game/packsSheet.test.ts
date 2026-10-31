// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';

// The module keeps an opening storage refused for the visit, so each test loads its own copy
// (docs/DEVELOPMENT.md, Modules that keep state for the load).
let hasSeenPacksSheet: typeof import('./packsSheet').hasSeenPacksSheet;
let markPacksSheetSeen: typeof import('./packsSheet').markPacksSheetSeen;
const load = async () => ({ hasSeenPacksSheet, markPacksSheetSeen } = await import('./packsSheet'));
const refuse = (method: 'getItem' | 'setItem', name = 'QuotaExceededError') =>
  vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException('refused', name); });

describe('the Packs sheet seen flag', () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    await load();
  });

  it('is unset on a device that never opened the sheet', () => {
    expect(hasSeenPacksSheet()).toBe(false);
  });

  it('is kept on the device, so it holds after a reload', async () => {
    expect(markPacksSheetSeen()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.PACKS_SHEET_SEEN)).toBe('1');
    vi.resetModules();
    await load();
    expect(hasSeenPacksSheet()).toBe(true);
  });

  it('writes nothing but its own key: no save or player identity is touched', () => {
    markPacksSheetSeen();
    expect(Object.keys({ ...localStorage })).toEqual([STORAGE_KEYS.PACKS_SHEET_SEEN]);
  });

  it('reads anything but its own mark as unseen', () => {
    localStorage.setItem(STORAGE_KEYS.PACKS_SHEET_SEEN, 'yes');
    expect(hasSeenPacksSheet()).toBe(false);
  });

  it('holds for the visit when storage is full, and is gone on the next load', async () => {
    refuse('setItem');
    expect(markPacksSheetSeen()).toBe(false);
    expect(hasSeenPacksSheet()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.PACKS_SHEET_SEEN)).toBeNull();
    vi.restoreAllMocks();
    vi.resetModules();
    await load();
    expect(hasSeenPacksSheet()).toBe(false);
  });

  it('holds for the visit when storage is blocked for reads and writes', () => {
    refuse('setItem', 'SecurityError');
    refuse('getItem', 'SecurityError');
    expect(hasSeenPacksSheet()).toBe(false);
    expect(markPacksSheetSeen()).toBe(false);
    expect(hasSeenPacksSheet()).toBe(true);
  });

  it('keeps the visit\'s mark once a later write is let through', () => {
    const refused = refuse('setItem');
    markPacksSheetSeen();
    refused.mockRestore();
    expect(markPacksSheetSeen()).toBe(true);
    expect(hasSeenPacksSheet()).toBe(true);
  });
});
