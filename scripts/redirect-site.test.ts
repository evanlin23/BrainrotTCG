import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { SETS } from '../src/content/sets/index.ts';
import { PAGE_TITLES, pageHash, setLinkHash, type Page } from '../src/game/route.ts';
import { copyHallOfFame, redirectPage } from './redirect-site.ts';

const NEW = 'https://brainrottcg.pages.dev/';
const PROOF = 'v4.' + 'A'.repeat(80);
const PROFILE = 'a'.repeat(120);

/** Opens the old address at `url` and runs the page's script, with `save` in its storage and `opener` as the window that opened it. */
const visit = (url: string, save: Record<string, string> = {}, opener: { postMessage: (data: unknown, origin: string) => void } | null = null) => {
  const script = /<script>([\s\S]*)<\/script>/.exec(redirectPage(NEW))![1];
  const { pathname, hash } = new URL(url);
  const elements: Record<string, { hidden?: boolean; textContent?: string; onclick?: () => void }> = {};
  let target: string | null = null;
  const messageListeners: ((e: { origin: string; source: unknown; data: unknown }) => void)[] = [];
  let openCall: { url: string; target: string; features: string } | null = null;
  const popup = {
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  const timers: { callback: () => void; ms: number }[] = [];
  const fakeSetTimeout = (callback: () => void, ms: number) => {
    timers.push({ callback, ms });
    return timers.length;
  };
  const fakeClearTimeout = vi.fn();
  runInNewContext(script, {
    URL,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    location: { pathname, hash, replace: (to: string) => { target = to; } },
    document: { getElementById: (id: string) => (elements[id] ??= {}) },
    localStorage: {
      get length() { return Object.keys(save).length; },
      key: (i: number) => Object.keys(save)[i] ?? null,
      getItem: (key: string) => save[key] ?? null,
      setItem: (k: string, v: string) => { save[k] = v; },
    },
    window: {
      opener,
      open: (url: string, target: string, features: string) => {
        openCall = { url, target, features };
        return popup;
      },
      addEventListener: (type: string, listener: (e: { origin: string; source: unknown; data: unknown }) => void) => {
        if (type === 'message') messageListeners.push(listener);
      },
      removeEventListener: (type: string, listener: (e: { origin: string; source: unknown; data: unknown }) => void) => {
        if (type === 'message') {
          const idx = messageListeners.indexOf(listener);
          if (idx !== -1) messageListeners.splice(idx, 1);
        }
      },
    },
  });
  return {
    get target() { return target; },
    elements,
    popup,
    get openCall() { return openCall; },
    messageListeners,
    timers,
    fakeClearTimeout,
    save,
  };
};

describe('redirectPage', () => {
  const pages = (Object.keys(PAGE_TITLES) as Page[]).map(pageHash);

  it.each([...pages, `#/pull/${PROOF}`, '#/pull/cut-off', `#/profile/${PROFILE}`, ...SETS.map((set) => setLinkHash(set.id)), '#/set/right-now/'])(
    'carries %s to the same place at the new address',
    (hash) => {
      expect(visit(`https://evanlin23.github.io/BrainrotTCG/${hash}`).target).toBe(NEW + hash);
    },
  );

  it('keeps the path below the old base, with its route', () => {
    expect(visit(`https://evanlin23.github.io/BrainrotTCG/p/0123abcd.html#/pull/${PROOF}`).target).toBe(`${NEW}p/0123abcd.html#/pull/${PROOF}`);
    expect(visit('https://evanlin23.github.io/BrainrotTCG/s/genesis/').target).toBe(`${NEW}s/genesis/`);
    expect(visit('https://evanlin23.github.io/BrainrotTCG/index.html#/cards').target).toBe(`${NEW}#/cards`);
  });

  it.each(['', '#', '#/open', '#/receive', '#/send', '#/cards/x', '#/settingsx', '#/set/', '#/set/Genesis', '#/set/a/b', '#/sets/genesis', '#javascript:alert(1)'])(
    "drops %s, which isn't one of the app's routes",
    (hash) => {
      expect(visit(`https://evanlin23.github.io/BrainrotTCG/${hash}`).target).toBe(NEW);
    },
  );

  it('offers to bring a save first, and going without it still keeps the route', () => {
    const page = visit('https://evanlin23.github.io/BrainrotTCG/#/set/genesis', { 'brainrot-save-v1': '{}' });
    expect(page.target).toBeNull();
    expect(page.elements.choice.hidden).toBe(false);
    page.elements.skip.onclick!();
    expect(page.target).toBe(`${NEW}#/set/genesis`);
  });

  it('opens receiver popup, sets bounded timer, and shows actionable status on handshake timeout', () => {
    const page = visit('https://evanlin23.github.io/BrainrotTCG/#/cards', { 'brainrot-player-v1': '{"key":"1"}' });
    page.elements.bring.onclick!();

    expect(page.openCall).toEqual({
      url: `${NEW}#/receive`,
      target: 'brainrot-receive',
      features: 'popup,width=440,height=360',
    });
    expect(page.elements.status.textContent).toBe('Bringing your save over…');
    expect(page.timers).toHaveLength(1);
    expect(page.timers[0].ms).toBe(15000);
    expect(page.messageListeners).toHaveLength(1);

    // Timeout triggers with no handshake
    page.timers[0].callback();
    expect(page.elements.status.textContent).toBe("Transfer didn't finish. Tap to try again, or go without your save.");
    expect(page.save['brainrot-moved-v1']).toBeUndefined();
    expect(page.target).toBeNull();
  });

  it('still counts an answer that comes after the timeout (a slow first load, or a player answering a question)', () => {
    const page = visit('https://evanlin23.github.io/BrainrotTCG/#/cards', { 'brainrot-player-v1': '{"key":"1"}' });
    page.elements.bring.onclick!();
    page.timers[0].callback();
    expect(page.messageListeners).toHaveLength(1);

    const listener = page.messageListeners[0];
    listener({ origin: new URL(NEW).origin, source: page.popup, data: { type: 'brainrot-ready' } });
    expect(page.popup.postMessage).toHaveBeenCalledOnce();
    expect(page.elements.status.textContent).toBe('Bringing your save over…');
    listener({ origin: new URL(NEW).origin, source: page.popup, data: { type: 'brainrot-move-result', result: 'saved' } });
    expect(page.save['brainrot-moved-v1']).toBeDefined();
    expect(page.target).toBe(`${NEW}#/cards`);
  });

  it('stops the timer once the new window is ready, so its question to the player has no deadline', () => {
    const page = visit('https://evanlin23.github.io/BrainrotTCG/#/cards', { 'brainrot-player-v1': '{"key":"1"}' });
    page.elements.bring.onclick!();
    page.fakeClearTimeout.mockClear();
    page.messageListeners[0]({ origin: new URL(NEW).origin, source: page.popup, data: { type: 'brainrot-ready' } });
    expect(page.fakeClearTimeout).toHaveBeenCalledWith(1);
  });

  it('opens a fresh window on retry when the last one never said it was ready, and reuses one that did', () => {
    const page = visit('https://evanlin23.github.io/BrainrotTCG/#/cards', { 'brainrot-player-v1': '{"key":"1"}' });
    page.elements.bring.onclick!();
    page.elements.bring.onclick!();
    expect(page.popup.close).toHaveBeenCalledOnce();

    page.messageListeners[0]({ origin: new URL(NEW).origin, source: page.popup, data: { type: 'brainrot-ready' } });
    page.elements.bring.onclick!();
    expect(page.popup.close).toHaveBeenCalledOnce();
  });

  it('cancels previous timer and cleans up listener when tapping bring again to retry', () => {
    const page = visit('https://evanlin23.github.io/BrainrotTCG/#/cards', { 'brainrot-player-v1': '{"key":"1"}' });
    page.elements.bring.onclick!();
    expect(page.messageListeners).toHaveLength(1);

    // Retry before timer expires
    page.elements.bring.onclick!();
    expect(page.fakeClearTimeout).toHaveBeenCalledWith(1);
    expect(page.messageListeners).toHaveLength(1); // Old listener removed, new listener added
    expect(page.elements.status.textContent).toBe('Bringing your save over…');
  });

  it('hands over save on ready handshake and marks moved when save succeeds', () => {
    const page = visit('https://evanlin23.github.io/BrainrotTCG/#/cards', { 'brainrot-player-v1': '{"key":"1"}' });
    page.elements.bring.onclick!();
    const listener = page.messageListeners[0];

    // Dispatches brainrot-ready from popup
    listener({ origin: new URL(NEW).origin, source: page.popup, data: { type: 'brainrot-ready' } });
    expect(page.popup.postMessage).toHaveBeenCalledWith(
      { type: 'brainrot-save', save: { 'brainrot-player-v1': '{"key":"1"}' } },
      new URL(NEW).origin,
    );

    // Popup reports saved
    listener({ origin: new URL(NEW).origin, source: page.popup, data: { type: 'brainrot-move-result', result: 'saved' } });
    expect(page.save['brainrot-moved-v1']).toBeDefined();
    expect(page.target).toBe(`${NEW}#/cards`);
    expect(page.messageListeners).toHaveLength(0);
  });

  it("sends its save to Save & backup (#/send) without marking it moved: that window can't say it arrived (#1035)", () => {
    const opener = { postMessage: vi.fn() };
    const save = { 'brainrot-player-v1': '{"key":"1"}' };
    const page = visit('https://evanlin23.github.io/BrainrotTCG/#/send', save, opener);
    expect(opener.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'brainrot-save', save: { 'brainrot-player-v1': '{"key":"1"}' } }, new URL(NEW).origin);
    expect(page.elements.status.textContent).toBe('Sent to brainrottcg.pages.dev. You can close this window.');
    expect(page.target).toBeNull();
    expect(page.save).toEqual({ 'brainrot-player-v1': '{"key":"1"}' });
    // The next old link still offers to bring it.
    const next = visit('https://evanlin23.github.io/BrainrotTCG/#/cards', page.save);
    expect(next.target).toBeNull();
    expect(next.elements.choice.hidden).toBe(false);
  });

  it('does not mark moved when transfer fails (e.g. storage full), leaving original save untouched for retry', () => {
    const page = visit('https://evanlin23.github.io/BrainrotTCG/#/cards', { 'brainrot-player-v1': '{"key":"1"}' });
    page.elements.bring.onclick!();
    const listener = page.messageListeners[0];

    listener({ origin: new URL(NEW).origin, source: page.popup, data: { type: 'brainrot-move-result', result: 'full' } });
    expect(page.save['brainrot-moved-v1']).toBeUndefined();
    expect(page.target).toBe(`${NEW}#/cards`);
  });
});

describe('copyHallOfFame', () => {
  it('copies the list and the rankings the Hall of Fame scripts read from the old address, and nothing else', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redirect-site-'));
    try {
      const dist = path.join(dir, 'dist');
      const out = path.join(dir, 'pages');
      mkdirSync(path.join(dist, 'rankings'), { recursive: true });
      mkdirSync(out);
      writeFileSync(path.join(dist, 'hall-of-fame.json'), '[]\n');
      writeFileSync(path.join(dist, 'rankings.json'), '{"index":1}\n');
      writeFileSync(path.join(dist, 'rankings', 'daily-2026-10.json'), '{"month":1}\n');
      writeFileSync(path.join(dist, 'index.html'), 'the game');
      copyHallOfFame(dist, out);
      expect(readdirSync(out, { recursive: true }).map(String).sort()).toEqual(['hall-of-fame.json', 'rankings', 'rankings.json', path.join('rankings', 'daily-2026-10.json')]);
      expect(readFileSync(path.join(out, 'rankings', 'daily-2026-10.json'), 'utf8')).toBe('{"month":1}\n');
      // A build without rankings (no token) copies just the list.
      rmSync(out, { recursive: true });
      mkdirSync(out);
      rmSync(path.join(dist, 'rankings'), { recursive: true });
      rmSync(path.join(dist, 'rankings.json'));
      copyHallOfFame(dist, out);
      expect(readdirSync(out)).toEqual(['hall-of-fame.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
