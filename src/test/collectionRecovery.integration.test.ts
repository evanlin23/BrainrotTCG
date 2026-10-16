// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { ALL_CARDS } from '../data/cards';
import { exportSaveFile } from '../game/saveFile';
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';
import type { CollectionItem } from '../types';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const SECRET = '01'.repeat(32);
const PLAYER = JSON.stringify({ secretKey: SECRET, name: 'Mounted fixture', nextNonce: 0, createdAt: 1 });
const readable = ALL_CARDS[0];
// One card the app can show, and two it can't: a partial unknown card and a null record.
const RAW = JSON.stringify({
  [readable.key]: { card: { id: readable.id, key: readable.key }, normalCount: 1, holoCount: 0 },
  'lost-set/ghost': { card: { id: 'ghost', key: 'lost-set/ghost' }, normalCount: 2, holoCount: 1 },
  'lost-set/null': null,
});
const SEED = {
  'brainrot-player-v1': PLAYER,
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
  [STORAGE_KEYS.COLLECTION]: RAW,
  // A current save: the v2 migration would rewrite the collection before the app reads it.
  [DATA_VERSION_KEY]: String(CURRENT_DATA_VERSION),
};

const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
  expect(element, `button ${label}`).toBeDefined();
  return element!;
};
const labelled = (label: string) => [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
  .some((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
const warnings = () => [...document.querySelectorAll('p[role="alert"].save-warning')].map((el) => el.textContent);
const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.COLLECTION)!) as Record<string, CollectionItem>;
const owned = (collection: Record<string, CollectionItem>) =>
  Object.values(collection).reduce((sum, item) => sum + item.normalCount + item.holoCount, 0);

const keptAside = () => document.querySelector('#save-backup')?.textContent ?? '';
// Download, caught at the file it saves: jsdom has no object URLs, can't follow the link, and its
// Blob can't be read back, so the file's text is taken as it is built.
async function download(current: NonNullable<typeof app>) {
  const texts: string[] = [];
  let name = '';
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      texts.push(parts?.map(String).join('') ?? '');
    }
  });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:kept-aside'; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { name = this.download; });
  await current.interact(() => button('Download').click());
  expect(texts, 'downloaded file').toHaveLength(1);
  return { name, file: JSON.parse(texts[0]) as { raw: string; player: string | null; later?: unknown[] } };
}

async function openPack(current: NonNullable<typeof app>) {
  await current.until('the pack shell is ready', () => expect(document.querySelector('[aria-label^="Open a "]')).not.toBeNull());
  await current.interact(() => {
    const shell = document.querySelector<HTMLElement>('[aria-label^="Open a "]')!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
  await current.until('real ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await current.interact(() => button('Skip opening animation').click());
  await current.until('Skip completes the summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
}

it('keeps unreadable collection entries through pack writes and offers them to download, discard or export', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  expect(warnings()).toEqual([]);

  await openPack(app);

  // The new collection has the readable card and the pack; the hidden entries left it, but not the browser.
  const afterFirst = stored();
  expect(afterFirst[readable.key]).toBeDefined();
  expect(afterFirst).not.toHaveProperty('lost-set/ghost');
  expect(owned(afterFirst)).toBe(1 + 5);
  const archive = localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)!;
  const { raw, player } = JSON.parse(archive) as { raw: string; player: string };
  expect(raw).toBe(RAW);
  expect(JSON.parse(player).secretKey).toBe(SECRET);
  expect(JSON.parse(exportSaveFile()).collectionRecovery).toBe(archive);

  // One note in the banner, with its actions; then in Save & backup while the banner steps aside.
  expect(warnings()).toEqual([expect.stringMatching(/Unreadable collection data was kept aside in this browser\. Download a copy, or discard it/)]);
  expect(warnings()[0]).not.toMatch(/couldn't be saved/);
  expect(button('Download')).toBeDefined();
  expect(button('Discard')).toBeDefined();
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(document.querySelector('.settings')).not.toBeNull());
  expect(document.querySelector('#save-backup h2')?.textContent).toBe('Save & backup');
  expect(button('Export')).toBeDefined();
  expect(warnings()).toEqual([]);
  expect(keptAside()).toMatch(/Kept-aside data[\s\S]*kept aside in this browser/);
  expect(button('Download')).toBeDefined();
  expect(button('Discard')).toBeDefined();
  await app.interact(() => button('Close Settings').click());
  await app.until('Open shows again', () => expect(document.querySelector<HTMLElement>('main.app-main')!.hidden).toBe(false));

  // Still offered after a reload; the next write keeps the archive as it was.
  await app.reload();
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);
  await openPack(app);
  expect(owned(stored())).toBe(1 + 10);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(archive);
}, 60_000);

it('saves the collection, and keeps the unreadable entries in this tab to download, when the archive cannot be written', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.COLLECTION_RECOVERY) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });

  await openPack(app);

  // The archive never blocks the save: the pack is stored, and the unreadable entries wait in this tab.
  expect(owned(stored())).toBe(1 + 5);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBeNull();
  expect(app.takeErrors(/kept in this tab only/)).toEqual([expect.stringContaining('QuotaExceededError')]);
  expect(warnings()).toEqual([expect.stringMatching(/no room to store it, so it lasts only until this tab closes or reloads\. Download it now/)]);
  expect(warnings()[0]).not.toMatch(/couldn't be saved/);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS)!).packsOpened).toBe(1);

  // Download saves them, with the identity they belonged to, to a dated file.
  const { name, file } = await download(app);
  expect(name).toBe('brainrot-collection-recovery-2026-01-01.json');
  expect(file.raw).toBe(RAW);
  expect(JSON.parse(file.player!).secretKey).toBe(SECRET);
}, 60_000);

it('shows the kept-aside note at once, and keeps the pack waiting, when only the collection write fails', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.COLLECTION) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });

  await openPack(app);

  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBe(RAW);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)!).raw).toBe(RAW);
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACKS)).not.toBeNull();
  expect(app.takeErrors(/^Failed to save to localStorage key /)).toEqual([expect.stringContaining(`"${STORAGE_KEYS.COLLECTION}"`)]);
  expect(warnings()).toEqual([expect.stringMatching(/couldn't be saved in this browser[\s\S]*kept aside/)]);
}, 60_000);

it('lets the player hide the kept-aside note until something new is kept aside; Settings still shows it', async () => {
  const archive = JSON.stringify({ raw: RAW, player: PLAYER });
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.COLLECTION]: '{}', [STORAGE_KEYS.COLLECTION_RECOVERY]: archive });
  await app.mount();
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);

  // Focus goes to the logo, not the page body, as the note and its buttons leave (#470).
  button('Hide note').focus();
  await app.interact(() => button('Hide note').click());
  expect(warnings()).toEqual([]);
  expect(document.activeElement).toBe(document.querySelector('h1.app-logo'));
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(document.querySelector('.settings')).not.toBeNull());
  expect(warnings()).toEqual([]);
  expect(keptAside()).toMatch(/Kept-aside data[\s\S]*kept aside/);
  await app.interact(() => button('Close Settings').click());
  await app.until('Open shows again', () => expect(document.querySelector<HTMLElement>('main.app-main')!.hidden).toBe(false));

  await app.reload();
  expect(warnings()).toEqual([]);

  // Another damaged payload joins the archive: the note comes back.
  localStorage.setItem(STORAGE_KEYS.COLLECTION_RECOVERY, JSON.stringify({ ...JSON.parse(archive), later: [{ raw: '{"x":null}', player: PLAYER }] }));
  await app.reload();
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);
});

it('discards the kept-aside data only after asking, and then forgets it', async () => {
  const archive = JSON.stringify({ raw: RAW, player: PLAYER });
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.COLLECTION]: '{}', [STORAGE_KEYS.COLLECTION_RECOVERY]: archive, [STORAGE_KEYS.COLLECTION_RECOVERY_SEEN]: 'an older note' });
  await app.mount();
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);

  // Discard asks first; the safe answer takes focus and reads the question.
  await app.interact(() => button('Discard').click());
  const keep = document.activeElement as HTMLElement;
  expect(keep.textContent).toBe('Keep it');
  expect(document.getElementById(keep.getAttribute('aria-describedby')!)?.textContent).toMatch(/Discard it for good\?/);
  await app.interact(() => keep.click());
  expect(document.activeElement?.textContent).toBe('Discard');
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(archive);

  const collection = localStorage.getItem(STORAGE_KEYS.COLLECTION);
  expect(collection).not.toBeNull();
  await app.interact(() => button('Discard').click());
  await app.interact(() => button('Discard for good').click());
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBeNull();
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBeNull();
  // Only the kept-aside data goes: the collection stays byte for byte.
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBe(collection);
  expect(warnings()).toEqual([]);
  // The note left with its buttons: focus goes to the page's heading.
  expect(document.activeElement?.matches('.app-logo, .page-title')).toBe(true);

  await app.reload();
  expect(warnings()).toEqual([]);
});

// Another tab imports a save or switches player: its old collection can land in the same archive (saveFile),
// so a tab still showing the old save must not discard it (its only copy) or download it mixed with its own.
const THEIRS = JSON.stringify({ secretKey: 'bb'.repeat(32), name: 'Other tab', nextNonce: 8, createdAt: 1 });
const THEIR_ARCHIVE = JSON.stringify({ raw: '{"their-set/lost":null}', player: THEIRS });
const otherTabSwitches = () => {
  localStorage.setItem('brainrot-player-v1', THEIRS);
  localStorage.setItem(STORAGE_KEYS.COLLECTION_RECOVERY, THEIR_ARCHIVE);
};

it('discards nothing from a tab whose save changed in another tab after the question was asked', async () => {
  const archive = JSON.stringify({ raw: RAW, player: PLAYER });
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.COLLECTION]: '{}', [STORAGE_KEYS.COLLECTION_RECOVERY]: archive, [STORAGE_KEYS.COLLECTION_RECOVERY_SEEN]: 'an older note' });
  await app.mount();
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);

  await app.interact(() => button('Discard').click());
  // The storage event can come late, or not at all: the confirm checks the save itself.
  otherTabSwitches();
  await app.interact(() => button('Discard for good').click());
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(THEIR_ARCHIVE);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBe('an older note');
  expect(localStorage.getItem('brainrot-player-v1')).toBe(THEIRS);
  // The reload warning takes the note's place, and its buttons leave with it, here and in Settings.
  expect(warnings()).toEqual([expect.stringMatching(/This save changed in another tab/)]);
  expect(warnings()[0]).not.toMatch(/kept aside/);
  for (const label of ['Download', 'Discard', 'Discard for good', 'Keep it', 'Hide note']) expect(labelled(label), label).toBe(false);
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(document.querySelector('.settings')).not.toBeNull());
  expect(document.querySelector('.settings')?.textContent).not.toMatch(/Kept-aside data/);
  for (const label of ['Download', 'Discard']) expect(labelled(label), label).toBe(false);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(THEIR_ARCHIVE);
});

it('downloads nothing from a tab whose save changed in another tab, and hides the actions once it hears', async () => {
  const archive = JSON.stringify({ raw: RAW, player: PLAYER });
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.COLLECTION]: '{}', [STORAGE_KEYS.COLLECTION_RECOVERY]: archive });
  await app.mount();
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);
  const files = vi.fn();
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      files();
    }
  });
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

  otherTabSwitches();
  await app.interact(() => button('Download').click());
  expect(files).not.toHaveBeenCalled();
  expect(anchorClick).not.toHaveBeenCalled();
  expect(warnings()).toEqual([expect.stringMatching(/This save changed in another tab/)]);
  for (const label of ['Download', 'Discard']) expect(labelled(label), label).toBe(false);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(THEIR_ARCHIVE);

  // A tab that hears of the switch first never offers them.
  await app.reload();
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);
  localStorage.setItem('brainrot-player-v1', PLAYER);
  await app.interact(() => window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-player-v1' })));
  expect(warnings()).toEqual([expect.stringMatching(/This save changed in another tab/)]);
  for (const label of ['Download', 'Discard']) expect(labelled(label), label).toBe(false);
  expect(files).not.toHaveBeenCalled();
});
