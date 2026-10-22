// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../data/cards';
import type { MoveResult } from './move';

/** The new address's window that the old address opened to hand its save over (receiveSave). */
const OLD_ORIGIN = 'https://old.example';
const COLLECTION = 'brainrot-found-collection-v1';
const player = (hex: string) => JSON.stringify({ secretKey: hex.repeat(32), name: 'Combo Miner', nextNonce: 3, createdAt: 1 });
const amogus = ALL_CARDS.find((c) => c.key === 'genesis/amogus')!;
const OLD = {
  'brainrot-player-v1': player('aa'),
  [COLLECTION]: JSON.stringify({ [amogus.key]: { card: { id: amogus.id, key: amogus.key }, normalCount: 1, holoCount: 0 } }),
  'brainrot-data-version': '3',
};

const opener = { postMessage: vi.fn() };
const confirm = vi.fn(() => true);
let close: ReturnType<typeof vi.fn>;

/** Storage with no room for the incoming collection (nor, once removed, the one that was here). */
const fillStorage = () => {
  const write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === COLLECTION) throw new DOMException('Injected quota failure', 'QuotaExceededError');
    write.call(this, key, value);
  });
};
const progressHere = () => {
  localStorage.setItem('brainrot-player-v1', player('bb'));
  localStorage.setItem(COLLECTION, '{"original":{"normalCount":2}}');
};

beforeEach(() => {
  vi.stubEnv('VITE_OLD_ORIGIN', OLD_ORIGIN);
  vi.stubEnv('VITE_OLD_SITE_URL', `${OLD_ORIGIN}/BrainrotTCG/`);
  vi.resetModules(); // move.ts reads the old address when it loads
  vi.stubGlobal('confirm', confirm);
  confirm.mockReset().mockReturnValue(true);
  opener.postMessage.mockReset();
  Object.defineProperty(window, 'opener', { value: opener, configurable: true });
  close = vi.fn();
  vi.stubGlobal('close', close);
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#/receive';
});

afterEach(async () => {
  const { stopReceiver } = await import('./move');
  stopReceiver();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.defineProperty(window, 'opener', { value: null, configurable: true });
  localStorage.clear();
});

describe('receiving a save in the window the old address opened', () => {
  it.each<{ name: string; result: MoveResult; closes: boolean; setup?: () => void; save?: unknown }>([
    { name: 'brought over', result: 'saved', closes: true },
    { name: 'already here', result: 'same', closes: true, setup: () => localStorage.setItem('brainrot-player-v1', player('aa')) },
    { name: 'the player kept their own', result: 'kept', closes: true, setup: () => { progressHere(); confirm.mockReturnValue(false); } },
    { name: 'not a save', result: 'invalid', closes: false, save: { 'brainrot-player-v1': '{not json' } },
    { name: 'storage full', result: 'full', closes: false, setup: fillStorage },
    { name: "a write that couldn't be undone", result: 'partial', closes: false, setup: () => { progressHere(); fillStorage(); } },
  ])('$name: reports $result, closing only when there is no note to read', async ({ result, closes, setup, save = OLD }) => {
    setup?.();
    const { FULL_MOVE_NOTE, PARTIAL_MOVE_NOTE, receiveSave } = await import('./move');
    const receiving = receiveSave();
    expect(opener.postMessage).toHaveBeenCalledWith({ type: 'brainrot-ready' }, OLD_ORIGIN);

    const event = new MessageEvent('message', { origin: OLD_ORIGIN, data: { type: 'brainrot-save', save } });
    Object.defineProperty(event, 'source', { value: opener });
    window.dispatchEvent(event);

    await expect(receiving).resolves.toBe(true);
    expect(opener.postMessage).toHaveBeenLastCalledWith({ type: 'brainrot-move-result', result }, OLD_ORIGIN);
    expect(close).toHaveBeenCalledTimes(closes ? 1 : 0);
    const shown = document.getElementById('root')!.textContent;
    if (result === 'full') expect(shown).toBe(FULL_MOVE_NOTE);
    if (result === 'partial') expect(shown).toBe(PARTIAL_MOVE_NOTE);
    if (result === 'invalid') expect(shown).toBe('Nothing was changed. You can close this window.');
  });

  it('restarts the handshake and succeeds when retried via fragment navigation while the popup is still open after storage full', async () => {
    fillStorage();
    const { FULL_MOVE_NOTE, receiveSave } = await import('./move');
    const receiving = receiveSave();
    expect(opener.postMessage).toHaveBeenCalledWith({ type: 'brainrot-ready' }, OLD_ORIGIN);

    // Initial attempt fails due to storage full
    const firstEvent = new MessageEvent('message', { origin: OLD_ORIGIN, data: { type: 'brainrot-save', save: OLD } });
    Object.defineProperty(firstEvent, 'source', { value: opener });
    window.dispatchEvent(firstEvent);

    await expect(receiving).resolves.toBe(true);
    expect(opener.postMessage).toHaveBeenLastCalledWith({ type: 'brainrot-move-result', result: 'full' }, OLD_ORIGIN);
    expect(close).not.toHaveBeenCalled();
    expect(document.getElementById('root')!.textContent).toBe(FULL_MOVE_NOTE);

    // Storage is restored
    vi.restoreAllMocks();
    opener.postMessage.mockClear();

    // Retrying with the popup still open: opener navigates the named window to #/receive (fragment navigation)
    window.location.hash = '#/receive';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    // Handshake restarts in the same retained document without re-running main
    expect(opener.postMessage).toHaveBeenCalledWith({ type: 'brainrot-ready' }, OLD_ORIGIN);
    expect(document.getElementById('root')!.textContent).toBe('Bringing your save over…');

    // Opener sends the save again
    const secondEvent = new MessageEvent('message', { origin: OLD_ORIGIN, data: { type: 'brainrot-save', save: OLD } });
    Object.defineProperty(secondEvent, 'source', { value: opener });
    window.dispatchEvent(secondEvent);

    // Save is successfully imported and popup closes
    expect(opener.postMessage).toHaveBeenLastCalledWith({ type: 'brainrot-move-result', result: 'saved' }, OLD_ORIGIN);
    expect(close).toHaveBeenCalledOnce();
    expect(localStorage.getItem('brainrot-player-v1')).toBe(OLD['brainrot-player-v1']);
    expect(localStorage.getItem(COLLECTION)).toBe(OLD[COLLECTION]);
  });
});
