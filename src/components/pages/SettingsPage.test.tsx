// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import { FULL_MOVE_NOTE, PARTIAL_MOVE_NOTE } from '../../game/move';
import { DEFAULT_SETTINGS } from '../../utils/settings';
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
