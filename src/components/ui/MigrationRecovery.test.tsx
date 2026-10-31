// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../../constants';
import { DATA_VERSION_KEY } from '../../utils/migrations';
import MigrationRecovery from './MigrationRecovery';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Not valid JSON on purpose: the file holds what is stored, unparsed.
const SAVE = {
  [STORAGE_KEYS.COLLECTION]: '{"image":{"card":{"id":"image"},"count":2}}',
  [STORAGE_KEYS.STATS]: '{"packsOpened":1,"highestPackValue":50',
  [STORAGE_KEYS.ACHIEVEMENTS]: '{"firstPack":{"unlockedAt":1}}',
  [DATA_VERSION_KEY]: '2',
  'brainrot-player-v1': '{"secretKey":"not exported"}',
};

let container: HTMLDivElement;
let root: Root;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
const snapshot = () => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]));

beforeEach(() => {
  localStorage.clear();
  for (const [key, value] of Object.entries(SAVE)) localStorage.setItem(key, value);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('says reloading alone will not help and offers the save as a file', () => {
  const reload = vi.fn();
  act(() => root.render(<MigrationRecovery reload={reload} />));
  expect(document.activeElement?.textContent).toBe('Your save needs room to update');
  expect(container.textContent).toContain("Reloading alone won't fix it.");
  act(() => button('Reload').click());
  expect(reload).toHaveBeenCalledTimes(1);
});

it('downloads the stored save keys exactly as stored, without changing storage', () => {
  const texts: string[] = [];
  let name = '';
  vi.stubGlobal('Blob', class extends Blob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      texts.push(parts?.map(String).join('') ?? '');
    }
  });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:save'; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    name = this.download;
  });
  const before = snapshot();

  act(() => root.render(<MigrationRecovery />));
  act(() => button('Download save data').click());

  expect(name).toMatch(/^brainrot-tcg-save-before-upgrade-\d{4}-\d{2}-\d{2}\.json$/);
  // The keys migrations rewrite, nothing else (the player's identity is not part of it).
  expect(JSON.parse(texts[0]).keys).toEqual({
    [STORAGE_KEYS.COLLECTION]: SAVE[STORAGE_KEYS.COLLECTION],
    [STORAGE_KEYS.STATS]: SAVE[STORAGE_KEYS.STATS],
    [STORAGE_KEYS.ACHIEVEMENTS]: SAVE[STORAGE_KEYS.ACHIEVEMENTS],
    [DATA_VERSION_KEY]: '2',
  });
  expect(snapshot()).toEqual(before);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Nothing was uploaded or changed.');
});

it('says so when the file could not be made', () => {
  act(() => root.render(<MigrationRecovery download={() => { throw new Error('no blobs'); }} />));
  act(() => button('Download save data').click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Couldn't make the file. Your save data is still in this browser, unchanged.");
});
