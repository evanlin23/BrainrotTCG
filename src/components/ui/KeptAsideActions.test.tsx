// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../../constants';
import { discardCollectionRecovery } from '../../game/collectionRecovery';
import KeptAsideActions from './KeptAsideActions';

const ARCHIVE = JSON.stringify({ raw: '{"lost-set/ghost":null}', player: null });

let root: Root;
let container: HTMLElement;
const onGone = vi.fn();

const button = (label: string) => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
};
const labels = () => [...container.querySelectorAll('button')].map((b) => b.textContent);
const click = (label: string) => act(() => button(label).click());

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  localStorage.setItem(STORAGE_KEYS.COLLECTION_RECOVERY, ARCHIVE);
  localStorage.setItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN, 'seen');
  onGone.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(() => root.render(<KeptAsideActions variant="settings" onGone={onGone} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  discardCollectionRecovery();
  vi.unstubAllGlobals();
});

describe('KeptAsideActions', () => {
  it('offers Download and Discard as keyboard-reachable buttons', () => {
    expect(labels()).toEqual(['Download', 'Discard']);
    for (const b of container.querySelectorAll('button')) expect(b.type).toBe('button');
  });

  it('asks before discarding, with the safe answer focused and describing the question', async () => {
    await click('Discard');
    expect(labels()).toEqual(['Keep it', 'Discard for good']);
    const keep = button('Keep it');
    expect(document.activeElement).toBe(keep);
    expect(document.getElementById(keep.getAttribute('aria-describedby')!)?.textContent).toBe('Discard it for good? Only a downloaded copy keeps it.');
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(ARCHIVE);

    await click('Keep it');
    expect(labels()).toEqual(['Download', 'Discard']);
    expect(document.activeElement).toBe(button('Discard'));
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(ARCHIVE);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('removes the archive and its dismissal once confirmed, then hands focus to the parent', async () => {
    await click('Discard');
    await click('Discard for good');
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBeNull();
    expect(onGone).toHaveBeenCalledOnce();
  });

  it('says so, and keeps focus on Discard, when storage refuses to remove it', async () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await click('Discard');
    await click('Discard for good');
    expect(onGone).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    const discard = button('Discard');
    expect(document.activeElement).toBe(discard);
    expect(document.getElementById(discard.getAttribute('aria-describedby')!)?.textContent).toBe("This browser wouldn't discard it.");
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(ARCHIVE);
  });

  it('saves the kept-aside data to a dated local file', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-04T12:00:00Z') });
    const texts: string[] = [];
    let name = '';
    let href = '';
    vi.stubGlobal('Blob', class extends Blob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        texts.push(parts?.map(String).join('') ?? '');
      }
    });
    const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return 'blob:kept-aside'; }
      static revokeObjectURL = revoke;
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download;
      href = this.href;
    });
    try {
      await click('Download');
      expect(name).toBe('brainrot-collection-recovery-2026-03-04.json');
      expect(href).toBe('blob:kept-aside');
      expect(JSON.parse(texts[0])).toEqual(JSON.parse(ARCHIVE));
      expect(container.querySelector('a')).toBeNull();
      vi.advanceTimersByTime(1000);
      expect(revoke).toHaveBeenCalledWith('blob:kept-aside');
      expect(onGone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the parent when nothing is left to download', async () => {
    localStorage.removeItem(STORAGE_KEYS.COLLECTION_RECOVERY);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await click('Download');
    expect(anchorClick).not.toHaveBeenCalled();
    expect(onGone).toHaveBeenCalledOnce();
  });
});
