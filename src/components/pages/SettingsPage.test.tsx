// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLatestSet } from '../../content/sets';
import { ALL_CARDS } from '../../data/cards';
import { FULL_MOVE_NOTE, PARTIAL_MOVE_NOTE } from '../../game/move';
import { DAMAGED_EXPORT_DONE_NOTE, DAMAGED_EXPORT_KEY_NOTE, EXPORT_DONE_NOTE, EXPORT_KEY_NOTE, importSaveFile, NEW_PLAYER_NO_ROOM_NOTE, NO_ROOM_FOR_COPY_NOTE, NO_ROOM_NOTE, STALE_SAVE_WARNING } from '../../game/saveFile';
import { SAVE_STAMP_KEY, type SaveMark } from '../../game/player';
import { CARD_FLIP_SRC, EFFECT_DELAY_MS, VINE_BOOM_SRC, soundGain } from '../../constants/audio';
import { SPECIAL_REVEAL_CUTOFF, SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';
import { DEFAULT_SETTINGS, effectsLevel } from '../../utils/settings';
import SettingsPage from './SettingsPage';
import { DOWNLOAD_DAMAGED_LABEL, START_NEW_PLAYER_QUESTION, UNREADABLE_PLAYER_NOTE } from './UnreadablePlayerRow';
import { KEPT_ASIDE_DOWNLOAD_LABEL } from '../ui/KeptAsideActions';
import { PLAYER_PAUSED_NOTE } from '../../game/collectionRecovery';

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

describe('focus after the old address Replace question (#978)', () => {
  /** A different save is already here, so Bring it asks first; the question's Keep mine has the focus. */
  const ask = async () => {
    localStorage.setItem('brainrot-player-v1', player('bb'));
    localStorage.setItem(COLLECTION, '{"original":{"normalCount":2}}');
    await click('Bring it');
    expect(document.activeElement).toBe(button('Keep mine'));
  };

  it('hands the focus to Bring it when Keep mine answers the question', async () => {
    await ask();
    await click('Keep mine');
    expect(note().textContent).toBe('Kept the save you have here.');
    expect(document.activeElement).toBe(button('Bring it'));
  });

  it('hands the focus to Bring it when the save does not fit and nothing changed', async () => {
    await ask();
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'brainrot-before-move-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      write.call(this, key, value);
    });
    await click('Replace');
    expect(note().textContent).toBe(FULL_MOVE_NOTE);
    expect(document.activeElement).toBe(button('Bring it'));
  });

  it('does not take the focus from another control when Bring it reports no save', async () => {
    fetchOldSave.mockResolvedValue('none');
    act(() => button('Export').focus());
    await click('Bring it');
    expect(note().textContent).toBe('There was no save at the old address.');
    expect(document.activeElement).toBe(button('Export'));
  });

  it('does not move the focus on the first render or on a later one', () => {
    expect(document.activeElement).toBe(document.body);
    act(() => button('Export').focus());
    act(() => root.render(<SettingsPage settings={{ ...DEFAULT_SETTINGS, effectsVolume: 0.5 }} onSettingsChange={() => {}} onImportSave={() => null} />));
    expect(document.activeElement).toBe(button('Export'));
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
    // status region gets a new keyed span (the count is its key), which is what a screen reader reads out.
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

  it('still names what reads in a save whose player or stats record is damaged', async () => {
    localStorage.setItem('brainrot-player-v1', '{not json');
    localStorage.setItem('brainrot-stats-v1', JSON.stringify({ packsOpened: 1 }));
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} />));

    await pick({ player: player('bb'), stats: '{not json' });
    expect(restoreNote().textContent).toBe("Replace this browser's save (1 pack) with the file's (Combo Miner)? Yours is kept as a backup.");
    await click('Keep mine');

    await pick({ player: '{not json', stats: JSON.stringify({ packsOpened: 'many' }) });
    expect(restoreNote().textContent).toBe("Replace this browser's save (1 pack) with the file's (unknown)? Yours is kept as a backup.");
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

  describe('focus after the Replace question (#978)', () => {
    const STATS = JSON.stringify({ packsOpened: 3 });
    const OTHER = { player: player('bb'), stats: JSON.stringify({ packsOpened: 5 }) };
    const renderWith = (onImportSave: (content: string, keepCopy?: boolean) => string | null) => {
      localStorage.setItem('brainrot-player-v1', player('aa'));
      localStorage.setItem('brainrot-stats-v1', STATS);
      act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));
    };
    /** Opens the question the way a keyboard user does: the answer is pressed with focus on it. */
    const askAndFocus = async (name: string) => {
      await pick(OTHER);
      act(() => button(name).focus());
      expect(document.activeElement).toBe(button(name));
    };
    const importButton = () => button('Import');

    it('moves focus from Import to Keep mine when the question opens after a file pick', async () => {
      renderWith(() => null);
      act(() => importButton().focus());
      await pick(OTHER);
      expect(button('Import')).toBeUndefined();
      expect(document.activeElement).toBe(button('Keep mine'));
    });

    it('moves focus from the page to Keep mine when the question opens after a file pick', async () => {
      renderWith(() => null);
      expect(document.activeElement).toBe(document.body);
      await pick(OTHER);
      expect(document.activeElement).toBe(button('Keep mine'));
    });

    it('leaves the focus on another control when the question opens', async () => {
      renderWith(() => null);
      act(() => button('Export').focus());
      await pick(OTHER);
      expect(button('Keep mine')).toBeDefined();
      expect(document.activeElement).toBe(button('Export'));
    });

    it('moves focus from Import to Keep mine when a file with no progress here has no room for a copy', async () => {
      const onImportSave = vi.fn((_content: string, keepCopy?: boolean): string | null => (keepCopy ? NO_ROOM_FOR_COPY_NOTE : null));
      act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={onImportSave} />));
      act(() => importButton().focus());
      await pick(OTHER);
      expect(button('Replace without a copy')).toBeDefined();
      expect(document.activeElement).toBe(button('Keep mine'));
    });

    it('puts focus on Import after Keep mine', async () => {
      renderWith(() => null);
      await askAndFocus('Keep mine');
      await click('Keep mine');
      expect(restoreNote().textContent).toBe('Kept your save.');
      expect(document.activeElement).toBe(importButton());
    });

    it('puts focus on Import after Replace, whether the import goes through or fails', async () => {
      const onImportSave = vi.fn((_content: string, _keepCopy?: boolean): string | null => null);
      renderWith(onImportSave);
      await askAndFocus('Replace');
      await click('Replace');
      expect(onImportSave).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(importButton());

      onImportSave.mockReturnValue(NO_ROOM_NOTE);
      await askAndFocus('Replace');
      await click('Replace');
      expect(restoreNote().textContent).toBe(NO_ROOM_NOTE);
      expect(document.activeElement).toBe(importButton());
    });

    it('puts focus on Import when Replace finds the save changed since the question', async () => {
      const onImportSave = vi.fn((_content: string, _keepCopy?: boolean): string | null => null);
      renderWith(onImportSave);
      await askAndFocus('Replace');
      localStorage.setItem(SAVE_STAMP_KEY, 'stamp-changed-elsewhere');
      await click('Replace');
      expect(restoreNote().textContent).toBe(STALE_SAVE_WARNING);
      expect(onImportSave).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(importButton());
    });

    it('keeps focus on the same button while the no-room question asks again, then on Import', async () => {
      const onImportSave = vi.fn((_content: string, keepCopy?: boolean): string | null => (keepCopy ? NO_ROOM_FOR_COPY_NOTE : null));
      renderWith(onImportSave);
      await askAndFocus('Replace');
      const replace = button('Replace');
      await click('Replace');
      // Same button, now offering to go on without a copy.
      expect(button('Replace without a copy')).toBe(replace);
      expect(document.activeElement).toBe(replace);
      await click('Keep mine');
      expect(document.activeElement).toBe(importButton());
      await askAndFocus('Replace');
      await click('Replace');
      await click('Replace without a copy');
      expect(onImportSave.mock.calls.map(([, keepCopy]) => keepCopy)).toEqual([true, true, false]);
      expect(document.activeElement).toBe(importButton());
    });
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

  it("opens What's new from Help, and leaves the button out when the page has nowhere to open it", () => {
    const opened: string[] = [];
    act(() => root.render(
      <SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} onOpenNews={() => opened.push('news')} />,
    ));
    const help = document.querySelector('[aria-labelledby="settings-help"]')!;
    expect([...help.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(["What's new", 'Report a problem']);
    act(() => button("What's new").click());
    expect(opened).toEqual(['news']);
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} />));
    expect(button("What's new")).toBeUndefined();
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

describe('Settings: pause on good pulls copy', () => {
  it('names both ways a card is held: Brainrot rarity, or the points cutoff (#68)', () => {
    const label = [...document.body.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent === 'Pause on good pulls');
    expect(label?.parentElement?.textContent).toContain(
      `Hold every Brainrot card, and any card worth ${SPECIAL_REVEAL_CUTOFF.toLocaleString()}+ points, for ${SPECIAL_REVEAL_DURATION_MS / 1000} seconds.`);
  });
});

describe('Settings: Show every page', () => {
  const switchLabels = () => [...document.body.querySelectorAll('[role="switch"]')].map((el) => document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent);

  it('is offered before the pages show on their own', () => {
    expect(switchLabels()).toContain('Show every page');
  });

  it('is left out, and only it, once they do (#902)', () => {
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} pagesUnlocked />));
    expect(switchLabels()).toEqual(['Particles', 'Pause on good pulls', 'Preview upcoming sets']);
    // And it comes back with the state: a different save here is not a stale flag from when the page mounted.
    act(() => root.render(<SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} pagesUnlocked={false} />));
    expect(switchLabels()).toContain('Show every page');
  });
});

describe('Settings: Motion', () => {
  const choices = () => ({
    group: document.body.querySelector<HTMLElement>('[role="radiogroup"][aria-labelledby]')!,
    auto: button('Auto'),
    reduced: button('Reduced'),
  });
  const renderWith = (settings: typeof DEFAULT_SETTINGS) => {
    const onSettingsChange = vi.fn();
    act(() => root.render(<SettingsPage settings={settings} onSettingsChange={onSettingsChange} onImportSave={() => null} />));
    return onSettingsChange;
  };

  it('offers Auto and Reduced as a named pair, Auto chosen for a save with no choice yet', () => {
    const { group, auto, reduced } = choices();
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Motion');
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toMatch(/device's reduced-motion setting/);
    expect(group.contains(auto) && group.contains(reduced)).toBe(true);
    expect(auto.getAttribute('role')).toBe('radio');
    expect(auto.getAttribute('aria-checked')).toBe('true');
    expect(reduced.getAttribute('aria-checked')).toBe('false');
    // One Tab stop: the chosen one.
    expect([auto.tabIndex, reduced.tabIndex]).toEqual([0, -1]);
    expect(auto.type).toBe('button');
  });

  it('shows a saved Reduced choice as chosen', () => {
    renderWith({ ...DEFAULT_SETTINGS, motion: 'reduced' });
    expect(choices().reduced.getAttribute('aria-checked')).toBe('true');
    expect(choices().auto.getAttribute('aria-checked')).toBe('false');
    expect([choices().auto.tabIndex, choices().reduced.tabIndex]).toEqual([-1, 0]);
  });

  it('moves the choice with the arrow keys, wrapping, and keeps the focus on the chosen one', async () => {
    const onSettingsChange = renderWith(DEFAULT_SETTINGS);
    const press = (key: string) => act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    choices().auto.focus();
    press('ArrowRight');
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, motion: 'reduced' });
    expect(document.activeElement).toBe(choices().reduced);
    // The parent hasn't re-rendered, so the choice is still Auto and a step left wraps to Reduced too.
    press('ArrowLeft');
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, motion: 'reduced' });
    act(() => root.render(<SettingsPage settings={{ ...DEFAULT_SETTINGS, motion: 'reduced' }} onSettingsChange={onSettingsChange} onImportSave={() => null} />));
    choices().reduced.focus();
    press('ArrowDown');
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, motion: 'auto' });
    onSettingsChange.mockClear();
    press('Home');
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('changes only Motion when a choice is pressed', async () => {
    const saved = { ...DEFAULT_SETTINGS, effectsVolume: 0.4, particlesEnabled: false, pauseBigPulls: false };
    const onSettingsChange = renderWith(saved);
    await click('Reduced');
    expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ ...saved, motion: 'reduced' });
    onSettingsChange.mockClear();
    act(() => root.render(<SettingsPage settings={{ ...saved, motion: 'reduced' }} onSettingsChange={onSettingsChange} onImportSave={() => null} />));
    await click('Auto');
    expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ ...saved, motion: 'auto' });
  });
});

describe('Settings: a player record that cannot be read (#1052)', () => {
  const rowNote = () => [...document.body.querySelectorAll('[role="status"]')].find((el) => el.previousElementSibling?.textContent === 'Player record')!;
  const DAMAGED = '{"secretKey":"not a key"';
  const renderUnreadable = (onStartNewPlayer: () => string | null) => act(() => root.render(
    <SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} playerUnreadable onStartNewPlayer={onStartNewPlayer} />,
  ));

  it('is left out while the record can be read', () => {
    expect(rowNote()).toBeUndefined();
  });

  it('says why packs are paused and offers Restore, Download and Start a new player', async () => {
    localStorage.setItem('brainrot-player-v1', DAMAGED);
    renderUnreadable(() => null);
    expect(rowNote().textContent).toBe(UNREADABLE_PLAYER_NOTE);
    // Restore is the backup file's Import.
    const pick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await click('Restore a backup');
    expect(pick).toHaveBeenCalledTimes(1);
    // Download is the save file, with the damaged bytes as they are, named and noted as a copy for recovery.
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:mock'; }), revokeObjectURL: vi.fn() });
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await click(DOWNLOAD_DAMAGED_LABEL);
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.contexts[0] as HTMLAnchorElement).download).toMatch(/^brainrot-tcg-damaged-player-/);
    const file = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blobs[0]);
    });
    expect(JSON.parse(file).player).toBe(DAMAGED);
    expect(rowNote().textContent).toBe(DAMAGED_EXPORT_DONE_NOTE);
  });

  it('says packs are paused once, names each Download for its file, and promises no key on Export', async () => {
    localStorage.setItem('brainrot-player-v1', DAMAGED);
    const recoveryNote = `Unreadable player data was kept aside. ${PLAYER_PAUSED_NOTE} It stays in this browser.`;
    act(() => root.render(
      <SettingsPage settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onImportSave={() => null} playerUnreadable onStartNewPlayer={() => null}
        recoveryNote={recoveryNote} recoveryAllowed={() => true} />,
    ));
    expect(document.body.textContent!.match(/packs are paused/gi)).toHaveLength(1);
    expect(document.body.textContent).toContain('Unreadable player data was kept aside. It stays in this browser.');
    const downloads = [...document.body.querySelectorAll('button')].map((el) => el.textContent!.trim()).filter((text) => text.startsWith('Download'));
    expect(downloads).toEqual([DOWNLOAD_DAMAGED_LABEL, KEPT_ASIDE_DOWNLOAD_LABEL]);

    const exportNote = () => button('Export').previousElementSibling!.querySelector('[role="status"]')!.textContent;
    expect(exportNote()).toBe(DAMAGED_EXPORT_KEY_NOTE);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await click('Export');
    expect(exportNote()).toBe(DAMAGED_EXPORT_DONE_NOTE);
  });

  it('asks before starting a new player, and shows why when it could not', async () => {
    const start = vi.fn(() => NEW_PLAYER_NO_ROOM_NOTE);
    renderUnreadable(start);
    await click('Start a new player');
    expect(rowNote().textContent).toBe(START_NEW_PLAYER_QUESTION);
    expect(document.activeElement).toBe(button('Keep my record'));
    await click('Keep my record');
    expect(start).not.toHaveBeenCalled();
    expect(rowNote().textContent).toBe(UNREADABLE_PLAYER_NOTE);
    expect(document.activeElement).toBe(button('Start a new player'));

    await click('Start a new player');
    await click('Start a new player');
    expect(start).toHaveBeenCalledTimes(1);
    expect(rowNote().textContent).toBe(NEW_PLAYER_NO_ROOM_NOTE);
    // Nothing changed, so every choice is still offered.
    expect(button('Restore a backup')).toBeDefined();
    expect(button(DOWNLOAD_DAMAGED_LABEL)).toBeDefined();
  });
});
