// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLatestSet } from '../../content/sets';
import { ALL_CARDS } from '../../data/cards';
import { FULL_MOVE_NOTE, PARTIAL_MOVE_NOTE } from '../../game/move';
import { NO_ROOM_FOR_COPY_NOTE, STALE_SAVE_WARNING } from '../../game/saveFile';
import { SAVE_STAMP_KEY, type SaveMark } from '../../game/player';
import { CARD_FLIP_SRC, EFFECT_DELAY_MS, VINE_BOOM_SRC, soundGain } from '../../constants/audio';
import { DEFAULT_SETTINGS, effectsLevel } from '../../utils/settings';
import SettingsPage from './SettingsPage';

// The old address answers with this save; importSave and storage are the real ones.
const fetchOldSave = vi.hoisted(() => vi.fn());
vi.mock('../../game/move', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/move')>()),
  canBringOldSave: () => true,
  fetchOldSave,
}));
const events = vi.hoisted(() => [] as string[]);
vi.mock('../../game/reload', () => ({ reloadPage: () => void events.push('reload') }));

const player = (hex: string) => JSON.stringify({ secretKey: hex.repeat(32), name: 'Combo Miner', nextNonce: 3, createdAt: 1 });
const amogus = ALL_CARDS.find((c) => c.key === 'genesis/amogus')!;
const COLLECTION = 'brainrot-found-collection-v1';
const OLD = {
  'brainrot-player-v1': player('aa'),
  [COLLECTION]: JSON.stringify({ [amogus.key]: { card: { id: amogus.id, key: amogus.key }, normalCount: 1, holoCount: 0 } }),
  'brainrot-data-version': '3',
};

let root: Root;
let container: HTMLElement;

/** Storage that has no room for the incoming collection (nor, once removed, the one that was here). */
const fillStorage = () => {
  const write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === COLLECTION) throw new DOMException('Injected quota failure', 'QuotaExceededError');
    write.call(this, key, value);
  });
};

// The Settings screen renders into a container in document.body (Page supplies its heading and close).
const note = () => [...document.body.querySelectorAll('[role="status"]')].find((el) => el.previousElementSibling?.textContent === 'From the old address')!;
const button = (name: string) => [...document.body.querySelectorAll('button')].find((el) => el.textContent?.trim() === name)!;
const click = async (name: string) => {
  await act(async () => button(name).click());
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('alert', vi.fn((message: string) => void events.push(`alert: ${message}`)));
  events.length = 0;
  localStorage.clear();
  fetchOldSave.mockReset().mockResolvedValue({ save: OLD });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root.render(
    <SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} />,
  ));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('Settings: bringing the old address save', () => {
  it('says storage is full, and changes nothing, when the save does not fit', async () => {
    fillStorage();
    await click('Bring it');
    expect(note().textContent).toBe(FULL_MOVE_NOTE);
    expect(localStorage.length).toBe(0);
    expect(events).toEqual([]);
  });

  it("alerts, then reloads, when a replaced save couldn't be fully put back", async () => {
    localStorage.setItem('brainrot-player-v1', player('bb'));
    localStorage.setItem(COLLECTION, '{"original":{"normalCount":2}}');
    await click('Bring it');
    expect(button('Replace')).toBeDefined(); // a different save is here: asked in the page first
    expect(events).toEqual([]);

    fillStorage();
    await click('Replace');
    expect(events).toEqual([`alert: ${PARTIAL_MOVE_NOTE}`, 'reload']);
    // The save that was here is kept as a backup.
    expect(JSON.parse(localStorage.getItem('brainrot-before-move-v1')!)).toMatchObject({ 'brainrot-player-v1': player('bb') });
  });
});

describe('Settings: importing a backup file', () => {
  const restoreNote = () => [...document.body.querySelectorAll('[role="status"]')].find((el) => el.previousElementSibling?.textContent === 'Restore')!;
  const pick = async (save: Record<string, string>) => {
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(save)], 'save.json')], configurable: true });
    const read = FileReader.prototype.readAsText;
    const loaded = new Promise((resolve) => vi.spyOn(FileReader.prototype, 'readAsText').mockImplementationOnce(function (this: FileReader, file: Blob) {
      this.addEventListener('load', resolve); // after the page's own onload
      read.call(this, file);
    }));
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await loaded;
    });
  };

  it("names only the saves being swapped when there's no room for a copy, not ones picked earlier", async () => {
    const stats = JSON.stringify({ packsOpened: 3 });
    localStorage.setItem('brainrot-player-v1', player('aa'));
    localStorage.setItem('brainrot-stats-v1', stats);
    const onImportSave = vi.fn((_content: string, _keepCopy?: boolean): string | null => NO_ROOM_FOR_COPY_NOTE);
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));

    await pick({ player: player('bb'), stats: JSON.stringify({ packsOpened: 5 }) });
    const saves = "this browser's save (Combo Miner, 3 packs) with the file's (Combo Miner, 5 packs)";
    expect(restoreNote().textContent).toBe(`Replace ${saves}? Yours is kept as a backup.`);
    await click('Replace');
    expect(restoreNote().textContent).toBe(`${NO_ROOM_FOR_COPY_NOTE} Replace ${saves} without keeping a copy?`);
    await click('Keep mine');

    // This browser's own save asks nothing first, so the no-room answer names no other file.
    await pick({ player: player('aa'), stats });
    expect(restoreNote().textContent).toBe(NO_ROOM_FOR_COPY_NOTE);
    await click('Replace without a copy');
    expect(onImportSave.mock.calls.map(([content, keepCopy]) => [JSON.parse(content).player, keepCopy]))
      .toEqual([[player('bb'), true], [player('aa'), true], [player('aa'), false]]);
  });

  it('invalidates pending replacement approval when storage changes before Replace is clicked', async () => {
    const stats = JSON.stringify({ packsOpened: 3 });
    localStorage.setItem('brainrot-player-v1', player('aa'));
    localStorage.setItem('brainrot-stats-v1', stats);
    const onImportSave = vi.fn((_content: string, _keepCopy?: boolean, _expectedSave?: SaveMark): string | null => null);
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));

    await pick({ player: player('bb'), stats: JSON.stringify({ packsOpened: 5 }) });
    expect(restoreNote().textContent).toContain('Replace');
    expect(button('Replace')).toBeDefined();

    // Storage changes before clicking Replace (e.g. another tab imports a save)
    localStorage.setItem(SAVE_STAMP_KEY, 'stamp-changed-elsewhere');

    await click('Replace');
    expect(restoreNote().textContent).toBe(STALE_SAVE_WARNING);
    expect(button('Replace')).toBeUndefined();
    expect(onImportSave).not.toHaveBeenCalled();

    // A fresh selection after storage changed reflects the new save and can succeed
    await pick({ player: player('bb'), stats: JSON.stringify({ packsOpened: 5 }) });
    expect(restoreNote().textContent).toContain('Replace');
    expect(button('Replace')).toBeDefined();
    await click('Replace');
    expect(onImportSave).toHaveBeenCalledTimes(1);
  });

  it('invalidates pending replacement without a copy retry when storage changes before clicking', async () => {
    const stats = JSON.stringify({ packsOpened: 3 });
    localStorage.setItem('brainrot-player-v1', player('aa'));
    localStorage.setItem('brainrot-stats-v1', stats);
    const onImportSave = vi.fn((_content: string, _keepCopy?: boolean, _expectedSave?: SaveMark): string | null => NO_ROOM_FOR_COPY_NOTE);
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));

    await pick({ player: player('bb'), stats: JSON.stringify({ packsOpened: 5 }) });
    await click('Replace');
    expect(button('Replace without a copy')).toBeDefined();

    // Storage changes before clicking "Replace without a copy"
    localStorage.setItem(SAVE_STAMP_KEY, 'stamp-changed-elsewhere');

    await click('Replace without a copy');
    expect(restoreNote().textContent).toBe(STALE_SAVE_WARNING);
    expect(button('Replace without a copy')).toBeUndefined();
    // onImportSave was only called for the initial Replace attempt, not the stale retry
    expect(onImportSave).toHaveBeenCalledTimes(1);
  });

  it('clears pending replacement prompt when saveWarning with onReload arrives', async () => {
    const stats = JSON.stringify({ packsOpened: 3 });
    localStorage.setItem('brainrot-player-v1', player('aa'));
    localStorage.setItem('brainrot-stats-v1', stats);
    const onImportSave = vi.fn((_content: string, _keepCopy?: boolean): string | null => null);
    const renderPage = (warning?: string, onReload?: () => void) => {
      act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} saveWarning={warning} onReload={onReload} />));
    };
    renderPage();

    await pick({ player: player('bb'), stats: JSON.stringify({ packsOpened: 5 }) });
    expect(button('Replace')).toBeDefined();

    // Stale warning arrives from tab guard
    renderPage(STALE_SAVE_WARNING, () => {});
    expect(button('Replace')).toBeUndefined();
    expect(button('Keep mine')).toBeUndefined();
  });
});

describe('Settings: Help', () => {
  it("has the card guide for the pack being opened beside Report a problem, and hands focus back when it closes", () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const set = getLatestSet('right-now')!;
    act(() => root.render(
      <SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} guideSet={set} />,
    ));
    const help = document.querySelector('[aria-labelledby="settings-help"]')!;
    expect([...help.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Card guide', 'Report a problem']);
    const guide = button('Card guide');
    guide.focus();
    act(() => guide.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Card guide');
    expect(dialog.textContent).toContain(`Rarity, modifiers and scoring for ${set.name}`);
    act(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(guide);
  });

  it('leaves the card guide out when no pack is given', () => {
    expect(button('Card guide')).toBeUndefined();
    expect(button('Report a problem')).toBeDefined();
  });
});

describe('Settings: effects volume preview', () => {
  it('plays the flip, then a vine boom after the delay, each at its gain on the chosen level', () => {
    vi.useFakeTimers();
    const played: { src: string; volume: number }[] = [];
    vi.stubGlobal('Audio', class {
      volume = 1;
      constructor(public src: string) {}
      play() { played.push({ src: this.src, volume: this.volume }); return Promise.resolve(); }
    });
    const slider = [...document.body.querySelectorAll<HTMLInputElement>('input[type="range"]')]
      .find((el) => el.labels?.[0]?.textContent === 'Sound effects')!;
    expect(slider).toBeDefined();
    slider.value = '50';
    act(() => void slider.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })));

    const level = effectsLevel(0.5);
    expect(played).toHaveLength(1);
    expect(played[0].src).toBe(CARD_FLIP_SRC);
    expect(played[0].volume).toBeCloseTo(level * soundGain(CARD_FLIP_SRC));
    vi.advanceTimersByTime(EFFECT_DELAY_MS - 1);
    expect(played).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(played).toHaveLength(2);
    expect(played[1].src).toBe(VINE_BOOM_SRC);
    expect(played[1].volume).toBeCloseTo(level * soundGain(VINE_BOOM_SRC));
  });

  it('drops the pending vine boom when the page closes', () => {
    vi.useFakeTimers();
    const played: string[] = [];
    vi.stubGlobal('Audio', class {
      volume = 1;
      constructor(public src: string) {}
      play() { played.push(this.src); return Promise.resolve(); }
    });
    const slider = [...document.body.querySelectorAll<HTMLInputElement>('input[type="range"]')]
      .find((el) => el.labels?.[0]?.textContent === 'Sound effects')!;
    slider.value = '50';
    act(() => void slider.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })));
    expect(played).toEqual([CARD_FLIP_SRC]);
    act(() => root.render(<div />));
    vi.advanceTimersByTime(EFFECT_DELAY_MS * 2);
    expect(played).toEqual([CARD_FLIP_SRC]);
  });
});
