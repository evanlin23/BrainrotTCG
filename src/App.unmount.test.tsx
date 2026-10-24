// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSet } from './content/sets';
import { putReopened, REOPEN_CACHE_KEY, __resetReopenCacheForTests as resetReopenCache } from './game/reopenCache';
import App from './App';

// What App leaves on a timer must not run once it has unmounted (in tests: after the page is torn down).
const reload = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock('./game/reload', () => reload);
vi.mock('./components/pack/PackOpener', () => ({ default: () => null }));
// An import that fails partway, so App offers the save from before and reloads a second later.
vi.mock('./game/saveFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./game/saveFile')>();
  return { ...actual, importSaveFile: () => actual.PARTIAL_IMPORT_NOTE, downloadSaveFile: () => 'save.json' };
});
// The settings screen, down to the import it is handed.
const settings = vi.hoisted(() => ({ onImportSave: undefined as undefined | ((data: string, keepCopy?: boolean) => string | null) }));
vi.mock('./components/ui/Page', () => ({
  default: (props: { screenProps: { onImportSave?: (data: string, keepCopy?: boolean) => string | null } }) => {
    settings.onImportSave = props.screenProps.onImportSave;
    return null;
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('confirm', () => true);
  vi.useFakeTimers();
  reload.reloadPage.mockReset();
  resetReopenCache();
  localStorage.clear();
  window.location.hash = '#/settings';
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(() => {
  container.remove();
  resetReopenCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = '';
});

const importPartway = () => act(() => void settings.onImportSave!('{}', false));

it('reloads a second after a part-done import while it is mounted', async () => {
  importPartway();
  await vi.advanceTimersByTimeAsync(999);
  expect(reload.reloadPage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(reload.reloadPage).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

it('drops that reload once it has unmounted', async () => {
  importPartway();
  await act(async () => root.unmount());
  await vi.runAllTimersAsync();
  expect(reload.reloadPage).not.toHaveBeenCalled();
});

it('writes a pending reopen-cache entry to storage as it unmounts', async () => {
  const set = getSet('genesis', 1)!;
  const card = set.cards[0];
  putReopened(set, 'ab'.repeat(32), 3, [{ setId: set.id, cardId: card.id, rarity: card.rarity, isHolo: false, slot: 0 }]);
  expect(localStorage.getItem(REOPEN_CACHE_KEY)).toBeNull();
  await act(async () => root.unmount());
  expect(Object.keys(JSON.parse(localStorage.getItem(REOPEN_CACHE_KEY) ?? '{}') as object)).toEqual([`genesis@1|${'ab'.repeat(32)}|3`]);
});
