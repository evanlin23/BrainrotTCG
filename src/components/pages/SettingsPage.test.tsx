// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLatestSet } from '../../content/sets';
import { ALL_CARDS } from '../../data/cards';
import { FULL_MOVE_NOTE, PARTIAL_MOVE_NOTE } from '../../game/move';
import { EXPORT_DONE_NOTE, EXPORT_KEY_NOTE, importSaveFile, NO_ROOM_FOR_COPY_NOTE, STALE_SAVE_WARNING } from '../../game/saveFile';
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

describe('Settings: exporting a backup file', () => {
  const backupNote = () => [...document.body.querySelectorAll('[role="status"]')].find((el) => el.previousElementSibling?.textContent === 'Back up')!;

  it('says the backup was downloaded, and keeps the warning that the file is private (#805)', async () => {
    localStorage.setItem('brainrot-player-v1', player('aa'));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });

    expect(backupNote().textContent).toBe(EXPORT_KEY_NOTE);
    await click('Export');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(backupNote().textContent).toMatch(/^Backup downloaded — keep it private\./);
    expect(backupNote().textContent).toContain('secret player key');
    // Exporting again keeps the confirmation (the file is made each time) and re-announces it: the
    // status region gets a new text node, which is what a screen reader reads out.
    const firstAnnouncement = backupNote().firstElementChild!;
    await click('Export');
    expect(clickSpy).toHaveBeenCalledTimes(2);
    expect(backupNote().textContent).toBe(EXPORT_DONE_NOTE);
    expect(firstAnnouncement.isConnected).toBe(false);
    expect(backupNote().firstElementChild).not.toBe(firstAnnouncement);
  });

  it('shows visible failure message when browser storage reads are denied, and succeeds on retry', async () => {
    localStorage.setItem('brainrot-player-v1', player('aa'));
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} />));

    // Mock download link trigger to verify no download occurred on failure
    const appendSpy = vi.spyOn(document.body, 'appendChild');

    // Deny storage read
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Controlled storage read denial', 'SecurityError');
    });

    await click('Export');
    expect(backupNote().textContent).toBe("Couldn't read browser storage to export your save.");
    expect(appendSpy).not.toHaveBeenCalled();

    // Restore storage read access
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(getItem);

    // Mock createObjectURL / revokeObjectURL for download
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    await click('Export');
    expect(backupNote().textContent).toBe(EXPORT_DONE_NOTE);
    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
  });
});

describe('Settings: importing a backup file', () => {
  const restoreNote = () => [...document.body.querySelectorAll('[role="status"]')].find((el) => el.previousElementSibling?.textContent === 'Restore')!;
  const pickRaw = async (content: string) => {
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File([content], 'save.json')], configurable: true });
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
  const pick = (save: Record<string, string>) => pickRaw(JSON.stringify(save));

  it('rejects null, array and primitive JSON files with useful message and no replacement prompt when progress exists', async () => {
    const stats = JSON.stringify({ packsOpened: 3 });
    localStorage.setItem('brainrot-player-v1', player('aa'));
    localStorage.setItem('brainrot-stats-v1', stats);
    const onImportSave = vi.fn((_content: string, _keepCopy?: boolean): string | null => null);
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));

    // null JSON
    await pickRaw('null');
    expect(restoreNote().textContent).toBe("That file isn't a supported Brainrot TCG save.");
    expect(button('Replace')).toBeUndefined();
    expect(onImportSave).not.toHaveBeenCalled();
    expect(localStorage.getItem('brainrot-player-v1')).toBe(player('aa'));

    // Array JSON
    await pickRaw('[1, 2, 3]');
    expect(restoreNote().textContent).toBe("That file isn't a supported Brainrot TCG save.");
    expect(button('Replace')).toBeUndefined();
    expect(onImportSave).not.toHaveBeenCalled();

    // Primitive number
    await pickRaw('12345');
    expect(restoreNote().textContent).toBe("That file isn't a supported Brainrot TCG save.");
    expect(button('Replace')).toBeUndefined();
    expect(onImportSave).not.toHaveBeenCalled();

    // Primitive string
    await pickRaw('"hello world"');
    expect(restoreNote().textContent).toBe("That file isn't a supported Brainrot TCG save.");
    expect(button('Replace')).toBeUndefined();
    expect(onImportSave).not.toHaveBeenCalled();

    // Primitive boolean
    await pickRaw('true');
    expect(restoreNote().textContent).toBe("That file isn't a supported Brainrot TCG save.");
    expect(button('Replace')).toBeUndefined();
    expect(onImportSave).not.toHaveBeenCalled();

    // Malformed JSON syntax
    await pickRaw('{ not valid json');
    expect(restoreNote().textContent).toBe("Couldn't read that file. Is it a save exported from Save & backup?");
    expect(button('Replace')).toBeUndefined();
    expect(onImportSave).not.toHaveBeenCalled();
    expect(localStorage.getItem('brainrot-player-v1')).toBe(player('aa'));
  });

  it('shows visible failure message when storage read is denied during preflight, and allows retry', async () => {
    const stats = JSON.stringify({ packsOpened: 3 });
    localStorage.setItem('brainrot-player-v1', player('aa'));
    localStorage.setItem('brainrot-stats-v1', stats);
    const onImportSave = vi.fn((_content: string, _keepCopy?: boolean): string | null => null);
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));

    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Controlled storage read denial', 'SecurityError');
    });

    await pick({ player: player('bb'), stats: JSON.stringify({ packsOpened: 5 }) });
    expect(restoreNote().textContent).toBe("Couldn't read browser storage to check your current save.");
    expect(button('Replace')).toBeUndefined();
    expect(onImportSave).not.toHaveBeenCalled();

    // Restore storage read access
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(getItem);

    // Retrying with restored storage access succeeds and shows the replacement prompt
    await pick({ player: player('bb'), stats: JSON.stringify({ packsOpened: 5 }) });
    const saves = "this browser's save (Combo Miner, 3 packs) with the file's (Combo Miner, 5 packs)";
    expect(restoreNote().textContent).toBe(`Replace ${saves}? Yours is kept as a backup.`);
    expect(button('Replace')).toBeDefined();
  });

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

  interface DeferredRead {
    reader: FileReader;
    file: Blob;
    finish: () => Promise<void>;
    fail: (err?: DOMException) => void;
  }

  const setupDeferredReads = () => {
    const reads: DeferredRead[] = [];
    const read = FileReader.prototype.readAsText;
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader, file: Blob) {
      reads.push({
        reader: this,
        file,
        finish: () =>
          new Promise<void>((resolve) => {
            this.addEventListener('load', () => resolve(), { once: true });
            read.call(this, file);
          }),
        fail: (err) => {
          Object.defineProperty(this, 'error', {
            value: err ?? new DOMException('Read failed', 'NotReadableError'),
            configurable: true,
          });
          this.dispatchEvent(new Event('error'));
        },
      });
    });
    return reads;
  };

  const dispatchFileInput = (content: string) => {
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File([content], 'save.json')], configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it('retires superseded readers so earlier selections completed out of order cannot overwrite prompt or import', async () => {
    const stats = JSON.stringify({ packsOpened: 3 });
    localStorage.setItem('brainrot-player-v1', player('aa'));
    localStorage.setItem('brainrot-stats-v1', stats);
    const onImportSave = vi.fn((_content: string, _keepCopy?: boolean): string | null => null);
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));

    const reads = setupDeferredReads();

    // Select older.json, then latest.json while both reads are pending
    dispatchFileInput(JSON.stringify({ player: player('bb'), stats: JSON.stringify({ packsOpened: 5 }) }));
    dispatchFileInput(JSON.stringify({ player: player('cc'), stats: JSON.stringify({ packsOpened: 9 }) }));
    expect(reads.length).toBe(2);

    // Complete latest first
    await act(async () => {
      await reads[1].finish();
    });
    const latestSaves = "this browser's save (Combo Miner, 3 packs) with the file's (Combo Miner, 9 packs)";
    expect(restoreNote().textContent).toBe(`Replace ${latestSaves}? Yours is kept as a backup.`);

    // Complete older second
    await act(async () => {
      await reads[0].finish();
    });
    // The prompt remains Latest and does not revert to Older
    expect(restoreNote().textContent).toBe(`Replace ${latestSaves}? Yours is kept as a backup.`);

    // Replace actually imports Latest, not Older
    await click('Replace');
    expect(onImportSave).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onImportSave.mock.calls[0][0]).player).toBe(player('cc'));
  });

  it('retires pending read and import intent when Settings closes so unmounted completion never invokes import', async () => {
    // Current save has 3 packs. Backup has matching player and pack count, which normally auto-imports.
    const stats = JSON.stringify({ packsOpened: 3 });
    localStorage.setItem('brainrot-player-v1', player('aa'));
    localStorage.setItem('brainrot-stats-v1', stats);
    const onImportSave = vi.fn((_content: string, _keepCopy?: boolean): string | null => null);
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));

    const reads = setupDeferredReads();

    // Select file matching current save
    dispatchFileInput(JSON.stringify({ player: player('aa'), stats }));
    expect(reads.length).toBe(1);

    // Leave Settings before native read completes (unmount)
    act(() => {
      root.unmount();
    });

    // Complete the read
    await act(async () => {
      await reads[0].finish();
    });

    // onImportSave was not called, preventing background writes or page reloads
    expect(onImportSave).not.toHaveBeenCalled();
  });

  it('handles current read failure with actionable feedback, keeps superseding aborts quiet, and allows fresh selections', async () => {
    localStorage.setItem('brainrot-player-v1', player('aa'));
    localStorage.setItem('brainrot-stats-v1', JSON.stringify({ packsOpened: 3 }));
    const onImportSave = vi.fn((_content: string, _keepCopy?: boolean): string | null => null);
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));

    const reads = setupDeferredReads();

    // 1. Select a file whose read fails
    dispatchFileInput(JSON.stringify({ player: player('bb'), stats: JSON.stringify({ packsOpened: 4 }) }));
    expect(reads.length).toBe(1);

    await act(async () => {
      reads[0].fail();
    });
    expect(restoreNote().textContent).toBe("Couldn't read that file. Try selecting it again.");
    expect(button('Replace')).toBeUndefined();

    // 2. Fresh selection while previous read was superseded: superseding abort is quiet
    dispatchFileInput(JSON.stringify({ player: player('cc'), stats: JSON.stringify({ packsOpened: 6 }) }));
    dispatchFileInput(JSON.stringify({ player: player('dd'), stats: JSON.stringify({ packsOpened: 7 }) }));
    expect(reads.length).toBe(3);

    // Abort/fail on superseded read (reads[1]) does not change the note to failure
    await act(async () => {
      reads[1].fail(new DOMException('The operation was aborted', 'AbortError'));
    });
    // Still shows the clean state, no error from aborted read
    expect(restoreNote().textContent).not.toBe("Couldn't read that file. Try selecting it again.");

    // Complete the active read (reads[2])
    await act(async () => {
      await reads[2].finish();
    });
    const expectedSaves = "this browser's save (Combo Miner, 3 packs) with the file's (Combo Miner, 7 packs)";
    expect(restoreNote().textContent).toBe(`Replace ${expectedSaves}? Yours is kept as a backup.`);
  });

  it('preserves live identity check against storage when a pending read finishes', async () => {
    localStorage.setItem('brainrot-player-v1', player('aa'));
    localStorage.setItem('brainrot-stats-v1', JSON.stringify({ packsOpened: 3 }));
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} />));

    const reads = setupDeferredReads();

    // Start reading incoming save
    dispatchFileInput(JSON.stringify({ player: player('bb'), stats: JSON.stringify({ packsOpened: 8 }) }));
    expect(reads.length).toBe(1);

    // While read is pending, live storage changes (e.g., opened more packs or switched save)
    localStorage.setItem('brainrot-stats-v1', JSON.stringify({ packsOpened: 15 }));

    // Finish reading
    await act(async () => {
      await reads[0].finish();
    });

    // The prompt accurately reflects the live save at completion time (15 packs, not 3)
    const expected = "this browser's save (Combo Miner, 15 packs) with the file's (Combo Miner, 8 packs)";
    expect(restoreNote().textContent).toBe(`Replace ${expected}? Yours is kept as a backup.`);
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

  it('binds "Replace without a copy" to the checked save when nothing asked first, so a newer save from another tab stays (#668)', async () => {
    // No progress here, so the file imports without a replacement prompt; the real import finds no room for the copy.
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ ...JSON.parse(player('aa')), nextNonce: 0 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify(DEFAULT_SETTINGS));
    const onImportSave = vi.fn((content: string, keepCopy?: boolean, expectedSave?: SaveMark) => importSaveFile(content, { keepCopy, expectedSave }));
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'brainrot-before-import-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      write.call(this, key, value);
    });
    await pickRaw(JSON.stringify({
      version: 2, exportedAt: '2026-10-14T00:00:00.000Z', dataVersion: 3, player: player('bb'),
      stats: JSON.stringify({ packsOpened: 5, holoCards: {}, highestPackCards: [] }), collection: '{}', achievements: '{}', hallOfFame: '{}',
    }));
    expect(restoreNote().textContent).toBe(NO_ROOM_FOR_COPY_NOTE);

    // Another tab imports this same player's save (only the stamp tells them apart) before this tab hears of it.
    localStorage.setItem(SAVE_STAMP_KEY, 'imported-elsewhere');
    localStorage.setItem('brainrot-stats-v1', JSON.stringify({ packsOpened: 7, holoCards: {}, highestPackCards: [] }));
    const stored = Object.fromEntries(Object.entries(localStorage));

    await click('Replace without a copy');
    expect(onImportSave).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(Object.entries(localStorage))).toEqual(stored);
    expect(localStorage.getItem('brainrot-before-import-v1')).toBeNull();
    expect(restoreNote().textContent).toBe(STALE_SAVE_WARNING);
    expect(button('Replace without a copy')).toBeUndefined();
    expect(events).toEqual([]);
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

describe('Settings: particles copy', () => {
  it('says where particles apply, so plain pulls without them do not read as a broken toggle', () => {
    const label = [...document.body.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent === 'Particles');
    const text = label?.parentElement?.textContent ?? '';
    expect(text).toMatch(/Epic and better/);
    expect(text).toMatch(/holos/);
    expect(text).toMatch(/swipe a pack open/);
    expect(text).toMatch(/Plain cards just flip/);
  });
});
