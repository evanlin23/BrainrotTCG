// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../../constants';
import { collectionRecoveryPrint, discardCollectionRecovery } from '../../game/collectionRecovery';
import KeptAsideActions from './KeptAsideActions';

const ARCHIVE = JSON.stringify({ raw: '{"lost-set/ghost":null}', player: null });

let root: Root;
let container: HTMLElement;
const onGone = vi.fn();
const onChanged = vi.fn();
const onLeave = vi.fn();
// Whether the tab may still act (App: same player, progress current), read on every click.
let allowed = true;
const canAct = vi.fn(() => allowed);

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
  onChanged.mockReset();
  onLeave.mockReset();
  allowed = true;
  canAct.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(() => root.render(<KeptAsideActions variant="settings" canAct={canAct} onGone={onGone} onChanged={onChanged} onLeave={onLeave} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  discardCollectionRecovery(collectionRecoveryPrint());
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

  it('makes the safe answer the prominent one and Discard for good an outlined danger button, after the warning (#641)', async () => {
    await click('Discard');
    const keep = button('Keep it');
    const discard = button('Discard for good');
    expect(keep.classList.contains('btn--primary')).toBe(true);
    expect(discard.classList.contains('btn--primary')).toBe(false);
    expect(discard.classList.contains('btn--danger')).toBe(true);
    const actions = container.querySelector('.settings-actions')!;
    expect(actions.classList.contains('settings-actions--ask')).toBe(true);
    const order = [...actions.querySelectorAll('.settings-desc, button')];
    expect(order.map((el) => el.textContent)).toEqual(['Discard it for good? Only a downloaded copy keeps it.', 'Keep it', 'Discard for good']);

    await click('Keep it');
    expect(container.querySelector('.settings-actions--ask')).toBeNull();
    expect(button('Discard').classList.contains('btn--danger')).toBe(false);
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

  it('asks again, without discarding, when the kept-aside data changed after the question', async () => {
    const changed = JSON.stringify({ raw: '{"lost-set/ghost":null}', player: null, later: [{ raw: '{"other":1}', player: null }] });
    await click('Discard');
    localStorage.setItem(STORAGE_KEYS.COLLECTION_RECOVERY, changed);
    button('Discard for good').focus();
    await click('Discard for good');
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(changed);
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBe('seen');
    expect(onGone).not.toHaveBeenCalled();
    // The parent refreshes its note to what is kept aside now.
    expect(onChanged).toHaveBeenCalledOnce();
    expect(labels()).toEqual(['Keep it', 'Discard for good']);
    const keep = button('Keep it');
    expect(document.activeElement).toBe(keep);
    expect(document.getElementById(keep.getAttribute('aria-describedby')!)?.textContent)
      .toBe('The kept-aside data changed since you asked. Discard it all for good? Only a downloaded copy keeps it.');

    // Confirmed against what is shown now, it goes.
    await click('Discard for good');
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBeNull();
    expect(onGone).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('refuses Download and Discard once this tab may no longer act on the data', async () => {
    allowed = false;
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await click('Download');
    expect(anchorClick).not.toHaveBeenCalled();
    await click('Discard');
    expect(labels()).toEqual(['Download', 'Discard']);
    expect(canAct).toHaveBeenCalledTimes(2);
    expect(onGone).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(ARCHIVE);
  });

  it('checks again at the confirm: a tab that went stale meanwhile keeps the data', async () => {
    await click('Discard');
    allowed = false;
    await click('Discard for good');
    expect(labels()).toEqual(['Download', 'Discard']);
    expect(onGone).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(ARCHIVE);
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBe('seen');
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

  it('shows failure note and keeps controls reachable when storage read is denied on Download, succeeding on retry', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key === STORAGE_KEYS.COLLECTION_RECOVERY) throw new DOMException('Controlled storage read denial', 'SecurityError');
      return getItem.call(localStorage, key);
    });

    await click('Download');
    expect(anchorClick).not.toHaveBeenCalled();
    expect(onGone).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Couldn't read browser storage to download your recovery file.");
    expect(labels()).toEqual(['Download', 'Discard']);
    // Nothing removed or rewritten: the archive and its hidden-note fingerprint are byte for byte as they were.
    expect(getItem.call(localStorage, STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(ARCHIVE);
    expect(getItem.call(localStorage, STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBe('seen');
    expect(onChanged).not.toHaveBeenCalled();

    // Restore access
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(getItem);
    await click('Download');
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(onGone).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Couldn't read browser storage to download your recovery file.");
  });
  describe('the Download started note', () => {
    const NOTE = 'Download started — keep the recovery file safe.';
    const status = () => container.querySelector<HTMLElement>('[role="status"]');
    const stubAnchor = () => vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const at = (variant: 'banner' | 'settings') => (
      <KeptAsideActions variant={variant} canAct={canAct} onGone={onGone} onChanged={onChanged} onLeave={onLeave} />
    );

    it.each(['settings', 'banner'] as const)('in the %s variant: a polite status region is there before Download and says it started afterwards', async (variant) => {
      await act(() => root.render(at(variant)));
      stubAnchor();
      const region = status()!;
      expect(region, 'a status region from the start').not.toBeNull();
      expect(region.textContent).toBe('');
      await click('Download');
      // The same element, so a screen reader that was watching it hears the text arrive.
      expect(status()).toBe(region);
      expect(region.textContent?.trim()).toBe(NOTE);
      expect(region.getAttribute('aria-live')).toBeNull();
      expect(region.closest('[aria-live="assertive"]')).toBeNull();
    });

    it('announces a repeat Download again: the note is a fresh element each time', async () => {
      stubAnchor();
      await click('Download');
      const first = status()!.firstElementChild;
      expect(first?.textContent).toBe(NOTE);
      await click('Download');
      const second = status()!.firstElementChild;
      expect(second?.textContent).toBe(NOTE);
      expect(second).not.toBe(first);
      expect(first?.isConnected).toBe(false);
    });

    it('claims no more than that the download started, and clears when a Download fails, none is left, or Discard asks', async () => {
      stubAnchor();
      await click('Download');
      expect(status()!.textContent).not.toMatch(/saved|downloaded|complete/i);
      await click('Discard');
      expect(status()!.textContent).toBe('');
      await click('Keep it');
      expect(status()!.textContent).toBe('');

      await click('Download');
      expect(status()!.textContent).toBe(NOTE);
      const getItem = Storage.prototype.getItem;
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
        if (key === STORAGE_KEYS.COLLECTION_RECOVERY) throw new DOMException('denied', 'SecurityError');
        return getItem.call(localStorage, key);
      });
      await click('Download');
      expect(status()!.textContent).toBe('');
      expect(container.textContent).toContain("Couldn't read browser storage");
    });

    it('says nothing when this tab may no longer act', async () => {
      stubAnchor();
      allowed = false;
      await click('Download');
      expect(status()!.textContent).toBe('');
    });
  });
});

describe('KeptAsideActions leaving with focus inside', () => {
  // Like App and Settings: a stale tab drops the buttons and may show Reload (App's banner does,
  // Settings shows it when the warning is up) beside the section heading.
  const Parent = ({ withReload }: { withReload: boolean }) => {
    const [stale, setStale] = useState(false);
    const reloadRef = useRef<HTMLButtonElement>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);
    const allow = () => {
      if (allowed) return true;
      setStale(true);
      return false;
    };
    return (
      <section>
        <h2 ref={headingRef} tabIndex={-1}>Save &amp; backup</h2>
        {stale && withReload && <button type="button" ref={reloadRef}>Reload</button>}
        {!stale && (
          <KeptAsideActions variant="settings" canAct={allow} onGone={onGone} onChanged={onChanged} onLeave={() => {
            onLeave();
            (reloadRef.current ?? headingRef.current)?.focus();
          }} />
        )}
      </section>
    );
  };
  const render = (withReload: boolean) => act(() => root.render(<Parent withReload={withReload} />));

  it.each([
    [true, 'Discard', 'Reload'],
    [false, 'Discard', 'heading'],
    [true, 'Discard for good', 'Reload'],
    [false, 'Discard for good', 'heading'],
  ])('with Reload shown: %s, the tab going stale on %s moves focus to %s, not the page body', async (withReload, label, target) => {
    await render(withReload);
    if (label === 'Discard for good') await click('Discard');
    button(label).focus();
    allowed = false;
    await click(label);
    await Promise.resolve();
    expect(onLeave).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(target === 'Reload' ? button('Reload') : container.querySelector('h2'));
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(ARCHIVE);
  });

  it('calls only the latest onLeave once, even when the parent passed a new one just before they left (#470)', async () => {
    const earlier = vi.fn();
    const latest = vi.fn();
    const at = (leave: () => void) => <KeptAsideActions variant="settings" canAct={canAct} onGone={onGone} onChanged={onChanged} onLeave={leave} />;
    await act(() => root.render(at(earlier)));
    button('Discard').focus();
    // A re-render with a new handler, then the controls leave, before any microtask runs.
    act(() => {
      flushSync(() => root.render(at(latest)));
      flushSync(() => root.render(null));
    });
    await Promise.resolve();
    expect(earlier).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });

  it('leaves focus alone when it was elsewhere', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await act(() => root.render(null));
    await Promise.resolve();
    expect(onLeave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
