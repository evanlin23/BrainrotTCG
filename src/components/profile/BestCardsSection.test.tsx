// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BestCardsSection from './BestCardsSection';
import { STORAGE_KEYS } from '../../constants';
import { getSet } from '../../content/sets';
import { cardPoints, type PulledCard, type TicketFn } from '../../engine';
import { toPulled } from '../../game/cardCode';
import { getBestCards, mergeBestCards, resetBestCards, type BestCandidate } from '../../game/bestCards';

const KEY = 'ab'.repeat(32);
const { used, sync, rebuild, derive, who } = vi.hoisted(() => ({
  used: { value: 0 },
  /** The player on screen; a test changes it to switch players mid-rebuild. */
  who: { key: 'ab'.repeat(32) },
  sync: { fail: false },
  rebuild: vi.fn(),
  /** Nonces whose ticket derivation fails right now (a transient failure the real rebuild reports as `failed`). */
  derive: { failing: new Set<number>() },
}));

// Only the key and ticket count are faked; the list itself is read from (jsdom's) real storage.
vi.mock('../../game/player', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/player')>()),
  getPlayerTickets: () => ({ player: { publicKeyHex: who.key }, nextNonce: used.value }),
}));
// Weighing the packs a profile can recover needs the pack cache; here it just re-reads the list.
vi.mock('../../game/profiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../game/profiles')>();
  const best = await import('../../game/bestCards');
  return {
    ...real,
    syncMyBestCards: () => {
      if (sync.fail) throw new Error('Pack cache unreadable');
      return best.getBestCards('ab'.repeat(32), used.value);
    },
  };
});
// Rebuilding derives packs with Argon2id; a cheap ticket keeps it deterministic and fast.
vi.mock('../../game/bestCards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../game/bestCards')>();
  const ticketFn: TicketFn = async (_set, key, nonce) => {
    if (derive.failing.has(nonce)) throw new Error('Argon2 unavailable');
    const ticket = new Uint8Array(32);
    ticket.set(key.subarray(0, 31));
    ticket[31] = nonce & 255;
    return ticket;
  };
  rebuild.mockImplementation((key: string, n: number, options = {}) => real.rebuildBestCards(key, n, { ...options, ticketFn }));
  return { ...real, rebuildBestCards: rebuild };
});

const SET = getSet('right-now', 2)!;
const points = (rarity: PulledCard['rarity']) => cardPoints(rarity, false, null, false);
const byPoints = [...SET.cards].sort((a, b) => points(b.rarity) - points(a.rarity));
const TOP = byPoints[0];
const WEAK = byPoints[byPoints.length - 1];

const pack = (nonce: number, ids: string[], mods: { holo?: boolean; finish?: 'GOLD' }[] = []): BestCandidate => ({
  setId: SET.id,
  setVersion: SET.version,
  nonce,
  openedAt: 1000 + nonce,
  cards: toPulled(ids.map((id, i) => ({ id, holo: !!mods[i]?.holo, finish: mods[i]?.finish })), SET)!,
});
const weak = (nonce: number) => pack(nonce, Array(SET.packSize).fill(WEAK.id));
/** Offers packs the way the pack list does: the weighed mark moves over each taken ticket that follows it. */
const offer = (...packs: BestCandidate[]) =>
  mergeBestCards(KEY, packs, (w, taken) => {
    let through = w;
    while (taken.has(through)) through++;
    return through;
  });

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  localStorage.clear();
  resetBestCards();
  used.value = 0;
  who.key = KEY;
  sync.fail = false;
  rebuild.mockClear();
  derive.failing.clear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (props: { refreshKey?: string; cacheReady?: boolean } = {}) =>
  act(() => root.render(<BestCardsSection refreshKey="a" cacheReady {...props} />));
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('button.best-card-row')];
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const text = (el: Element) => el.textContent ?? '';

describe('the rows', () => {
  it('lists the best cards under a "Best cards" heading, best first, each a button naming card, version, ticket and points', () => {
    used.value = 2;
    offer(
      pack(0, [WEAK.id, TOP.id, WEAK.id, WEAK.id, WEAK.id]),
      pack(1, [WEAK.id, WEAK.id, WEAK.id, WEAK.id, WEAK.id], [{ holo: true, finish: 'GOLD' }]),
    );
    render();

    const section = container.querySelector('section')!;
    expect(section.getAttribute('aria-labelledby')).toBe('best-cards-title');
    expect(container.querySelector('#best-cards-title')?.textContent).toBe('Best cards');
    expect(rows()).toHaveLength(SET.packSize * 2);

    const [first, second] = rows();
    // The gold holo wins on points; the plain top card follows.
    expect(text(first)).toContain(WEAK.name);
    expect(text(first)).toContain('Gold · Holo');
    expect(text(first)).toContain('ticket #1');
    expect(text(second)).toContain(TOP.name);
    expect(text(second)).toContain('Plain');
    expect(text(second)).toContain('ticket #0');

    const scores = rows().map((row) => Number(text(row.querySelector('.pull-row-score')!).replace(/\D/g, '')));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(text(first.querySelector('.pull-row-score')!)).toContain(`${scores[0].toLocaleString()} pts points`);
    // The accessible name is spoken text, not the thumbnail (hidden from assistive tech with empty alt).
    expect(first.querySelector('.pull-row-thumbs')?.getAttribute('aria-hidden')).toBe('true');
    expect(first.querySelectorAll('.sr-only').length).toBeGreaterThan(0);
    expect(first.disabled).toBe(false);
    // The viewer hands focus back by script, so the row is quiet after a press and rings after Escape (base.css, #312).
    expect(rows().every((row) => row.classList.contains('quiet-focus'))).toBe(true);
  });

  it('shows at most ten', () => {
    used.value = 3;
    offer(
      pack(0, [TOP.id, TOP.id, TOP.id, TOP.id, TOP.id]),
      pack(1, [TOP.id, TOP.id, TOP.id, TOP.id, TOP.id]),
      pack(2, [TOP.id, TOP.id, TOP.id, TOP.id, TOP.id]),
    );
    render();
    expect(rows()).toHaveLength(10);
    // Equal points break ties by the lower ticket, so the dropped five are all of the newest pack.
    expect(rows().every((row) => !text(row).includes('ticket #2'))).toBe(true);
  });

  it('adds a note when the list is only the best among the packs this device holds', () => {
    used.value = 3; // tickets 0..2 were used, but only ticket 0 and 2 can be weighed
    offer(weak(0), weak(2));
    render();
    expect(text(container)).toContain('The best among the packs saved on this device.');

    resetBestCards();
    localStorage.clear();
    used.value = 1;
    offer(weak(0));
    render({ refreshKey: 'b' });
    expect(text(container)).not.toContain('The best among the packs saved on this device.');
  });

  it('picks up packs that arrive later (the refresh key changes)', () => {
    used.value = 1;
    render();
    expect(rows()).toHaveLength(0);
    offer(weak(0));
    render({ refreshKey: 'b' });
    expect(rows()).toHaveLength(SET.packSize);
  });
});

describe('with nothing to list', () => {
  it('says so in one line when no card has been collected', () => {
    render();
    expect(container.querySelector('#best-cards-title')?.textContent).toBe('Best cards');
    expect(rows()).toHaveLength(0);
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(text(container.querySelector('p')!)).toBe('None on this device yet. Open a pack and its best cards collect here.');
  });

  it.each([
    ['an empty list for this key', JSON.stringify({ [KEY]: { w: 0, b: [] } })],
    ['only another key\'s list', JSON.stringify({ ['cd'.repeat(32)]: { w: 1, b: [{ s: SET.id, v: SET.version, n: 0, i: 0, c: 'x', t: 1 }] } })],
    ['storage that can\'t be read', '{not json'],
    ['a store that breaks the format', JSON.stringify({ [KEY]: { w: 'many', b: null } })],
  ])('renders an old save with %s without errors', (_name, raw) => {
    localStorage.setItem(STORAGE_KEYS.BEST_CARDS, raw);
    used.value = 4;
    expect(() => render()).not.toThrow();
    expect(rows()).toHaveLength(0);
    expect(text(container)).toContain('None on this device yet.');
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('leaves the list as stored when weighing the packs fails', () => {
    used.value = 1;
    offer(weak(0));
    sync.fail = true; // say, the pack cache is unreadable
    expect(() => render()).not.toThrow();
    expect(rows()).toHaveLength(SET.packSize);
  });

  it('shows no heading while the packs are still being read in', () => {
    render({ cacheReady: false });
    expect(container.querySelector('section')).toBeNull();
    expect(text(container)).toBe('');
    render({ cacheReady: true });
    expect(container.querySelector('#best-cards-title')).not.toBeNull();
  });
});

describe('winners an older save never scored', () => {
  /** How an older build stored them: the reference only, no cached card. */
  const unscored = () => {
    localStorage.setItem(
      STORAGE_KEYS.BEST_CARDS,
      JSON.stringify({ [KEY]: { w: 1, b: [{ s: SET.id, v: SET.version, n: 0, i: 0, t: 1000 }, { s: SET.id, v: SET.version, n: 0, i: 1, t: 1000 }] } }),
    );
    used.value = 1;
  };

  it('re-derives them once the saved packs are read in, then lists them', async () => {
    unscored();
    render({ cacheReady: false });
    expect(rebuild).not.toHaveBeenCalled();
    expect(container.querySelector('section')).toBeNull();

    await act(async () => root.render(<BestCardsSection refreshKey="a" cacheReady />));
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith(KEY, 1);
    expect(rows().length).toBeGreaterThan(0);
    expect(getBestCards(KEY, 1).cards.every((c) => c.card)).toBe(true);

    // The same key is not rebuilt again when the packs change.
    await act(async () => root.render(<BestCardsSection refreshKey="b" cacheReady />));
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  const retryButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
  const status = () => container.querySelector('[role="status"]');

  it('says the cards are unavailable, not that there are none, when the rebuild fails to derive a pack', async () => {
    unscored();
    derive.failing.add(0); // the real rebuild catches this and returns failed=1
    await act(async () => render());
    expect(rows()).toHaveLength(0);
    expect(text(container)).not.toContain('None on this device yet.');
    expect(text(status()!)).toContain("couldn't be loaded just now");
    expect(retryButton()).toBeDefined();
    expect(getBestCards(KEY, 1).cards).toHaveLength(2); // the references are kept

    // Packs changing or the list refreshing never mines again by itself.
    await act(async () => root.render(<BestCardsSection refreshKey="b" cacheReady />));
    expect(rebuild).toHaveBeenCalledTimes(1);

    derive.failing.clear();
    await act(async () => retryButton()!.click());
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(rows().length).toBeGreaterThan(0);
    expect(status()).toBeNull();
    expect(retryButton()).toBeUndefined();
  });

  it('says the same when the rebuild rejects, and retries the same load', async () => {
    unscored();
    rebuild.mockRejectedValueOnce(new Error('no Argon2'));
    await act(async () => render());
    expect(rows()).toHaveLength(0);
    expect(text(container)).not.toContain('None on this device yet.');
    expect(text(status()!)).toContain("couldn't be loaded just now");

    await act(async () => retryButton()!.click());
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(rebuild).toHaveBeenLastCalledWith(KEY, 1);
    expect(rows().length).toBeGreaterThan(0);
    expect(retryButton()).toBeUndefined();
  });

  it('moves focus to the first row after a Try again that settles it, since the button it was on is gone', async () => {
    unscored();
    derive.failing.add(0);
    await act(async () => render());
    retryButton()!.focus();
    derive.failing.clear();
    await act(async () => retryButton()!.click());
    expect(retryButton()).toBeUndefined();
    expect(document.activeElement).toBe(rows()[0]);
  });

  it('leaves focus alone when the player moved elsewhere while the retry was running', async () => {
    unscored();
    derive.failing.add(0);
    await act(async () => render());
    const elsewhere = document.body.appendChild(document.createElement('button'));
    try {
      retryButton()!.focus();
      derive.failing.clear();
      const impl = rebuild.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      rebuild.mockImplementationOnce(async (...args: Parameters<typeof impl>) => {
        await gate;
        return impl(...args);
      });
      await act(async () => retryButton()!.click());
      elsewhere.focus();
      await act(async () => release());
      expect(rows().length).toBeGreaterThan(0);
      expect(retryButton()).toBeUndefined();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it('does not take focus for a later rebuild when the retry itself started none', async () => {
    unscored();
    derive.failing.add(0);
    await act(async () => render());
    retryButton()!.focus();
    // The packs are no longer read in, so Try again starts nothing.
    render({ cacheReady: false });
    await act(async () => retryButton()!.click());
    expect(rebuild).toHaveBeenCalledTimes(1);
    derive.failing.clear();
    await act(async () => root.render(<BestCardsSection refreshKey="a" cacheReady />));
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(rows().length).toBeGreaterThan(0);
    expect(rows()).not.toContain(document.activeElement);
  });

  it('keeps focus on Try again when the retry fails too', async () => {
    unscored();
    derive.failing.add(0);
    await act(async () => render());
    retryButton()!.focus();
    await act(async () => retryButton()!.click());
    expect(document.activeElement).toBe(retryButton());
  });

  it('drops a rebuild that finishes after the player changed', async () => {
    unscored();
    let finish!: () => void;
    const real = rebuild.getMockImplementation()!;
    rebuild.mockImplementationOnce(
      (key: string, n: number) => new Promise((resolve) => { finish = () => resolve(real(key, n)); }),
    );
    await act(async () => render());
    who.key = 'cd'.repeat(32);
    await act(async () => finish());
    expect(rows()).toHaveLength(0);
    expect(status()).toBeNull();
  });

  it('drops a rejection that arrives after the player changed', async () => {
    unscored();
    let fail!: () => void;
    rebuild.mockImplementationOnce(() => new Promise((_, reject) => { fail = () => reject(new Error('no Argon2')); }));
    await act(async () => render());
    who.key = 'cd'.repeat(32);
    await act(async () => fail());
    expect(status()).toBeNull();
    expect(retryButton()).toBeUndefined();
  });

  it('keeps the cards that did load, and a failed retry keeps the guidance', async () => {
    localStorage.setItem(
      STORAGE_KEYS.BEST_CARDS,
      JSON.stringify({ [KEY]: { w: 2, b: [{ s: SET.id, v: SET.version, n: 0, i: 0, t: 1000 }, { s: SET.id, v: SET.version, n: 1, i: 0, t: 1001 }] } }),
    );
    used.value = 2;
    derive.failing.add(1);
    await act(async () => render());
    const partial = rows().length;
    expect(partial).toBeGreaterThan(0); // pack 0 rebuilt and is listed
    expect(text(status()!)).toContain('Some of your best cards');

    await act(async () => retryButton()!.click());
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(partial);
    expect(retryButton()).toBeDefined();

    derive.failing.clear();
    await act(async () => retryButton()!.click());
    expect(getBestCards(KEY, 2).cards.every((c) => c.card)).toBe(true);
    expect(rows().length).toBeGreaterThan(partial);
    expect(status()).toBeNull();
  });
});

describe('the settled signal', () => {
  /** How an older build stored them: the reference only, no cached card. */
  const unscored = () => {
    localStorage.setItem(
      STORAGE_KEYS.BEST_CARDS,
      JSON.stringify({ [KEY]: { w: 1, b: [{ s: SET.id, v: SET.version, n: 0, i: 0, t: 1000 }, { s: SET.id, v: SET.version, n: 0, i: 1, t: 1000 }] } }),
    );
    used.value = 1;
  };
  const retryButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
  const status = () => container.querySelector('[role="status"]');
  const settledCalls = () => onSettled.mock.calls.map(([settled]) => settled);
  const onSettled = vi.fn();
  const renderWith = (cacheReady: boolean) =>
    act(() => root.render(<BestCardsSection refreshKey="a" cacheReady={cacheReady} onSettledChange={onSettled} />));
  beforeEach(() => onSettled.mockClear());

  it('is false while the saved packs are still being read, then true once they are and nothing is unscored', async () => {
    used.value = 1;
    offer(weak(0));
    await renderWith(false);
    expect(settledCalls()).toEqual([false]);
    await renderWith(true);
    expect(settledCalls()).toEqual([false, true]);
  });

  it('is false while the rebuild runs for unscored winners, and true once they are scored', async () => {
    unscored();
    const gate: { open: () => void } = { open: () => {} };
    const opened = new Promise<void>((resolve) => (gate.open = resolve));
    const real = rebuild.getMockImplementation()!;
    rebuild.mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await opened;
      return real(...args);
    });
    await renderWith(true);
    expect(rebuild).toHaveBeenCalledTimes(1);
    // Unscored, then rebuilding: never settled meanwhile.
    expect(settledCalls().length).toBeGreaterThan(0);
    expect(settledCalls().every((settled) => settled === false)).toBe(true);

    await act(async () => gate.open());
    expect(getBestCards(KEY, 1).cards.every((c) => c.card)).toBe(true);
    expect(settledCalls()[settledCalls().length - 1]).toBe(true);
  });

  it('is true once the rebuild is lost (a pack could not be derived), since no card is on its way', async () => {
    unscored();
    derive.failing.add(0);
    await renderWith(true);
    expect(settledCalls()[settledCalls().length - 1]).toBe(true);
    expect(getBestCards(KEY, 1).cards.some((c) => !c.card)).toBe(true); // still unscored, yet settled
  });

  it('is true when the rebuild rejects', async () => {
    unscored();
    rebuild.mockRejectedValueOnce(new Error('Argon2 unavailable'));
    await renderWith(true);
    expect(settledCalls()[settledCalls().length - 1]).toBe(true);
  });

  it('does not wait on an unscored winner this build cannot rebuild (a set version it lacks), so it settles with no rebuild', async () => {
    // A backup from a newer build: no cached card, and a set version this build doesn't have.
    localStorage.setItem(
      STORAGE_KEYS.BEST_CARDS,
      JSON.stringify({ [KEY]: { w: 1, b: [{ s: SET.id, v: SET.version + 50, n: 0, i: 0, t: 1000 }] } }),
    );
    used.value = 1;
    await renderWith(true);
    expect(getBestCards(KEY, 1).cards.some((c) => !c.card)).toBe(true); // still unscored, yet nothing is on its way
    expect(rebuild).not.toHaveBeenCalled();
    expect(settledCalls()[settledCalls().length - 1]).toBe(true);
    expect(status()).toBeNull();
    expect(text(container)).toContain('None on this device yet.');
  });

  it('still waits on a rebuildable winner that sits beside one this build cannot rebuild', async () => {
    localStorage.setItem(
      STORAGE_KEYS.BEST_CARDS,
      JSON.stringify({
        [KEY]: { w: 1, b: [{ s: SET.id, v: SET.version + 50, n: 1, i: 0, t: 1001 }, { s: SET.id, v: SET.version, n: 0, i: 0, t: 1000 }] },
      }),
    );
    used.value = 2;
    const real = rebuild.getMockImplementation()!;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    rebuild.mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await opened;
      return real(...args);
    });
    await renderWith(true);
    expect(settledCalls().every((settled) => settled === false)).toBe(true);
    await act(async () => open());
    expect(settledCalls()[settledCalls().length - 1]).toBe(true);
  });

  it('stays settled through Try again after the rebuild was lost, with the note kept in place until the retry ends', async () => {
    unscored();
    derive.failing.add(0);
    await renderWith(true);
    expect(settledCalls()).toEqual([false, true]);
    expect(text(status()!)).toContain("couldn't be loaded just now");

    const real = rebuild.getMockImplementation()!;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    rebuild.mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await opened;
      return real(...args);
    });
    derive.failing.clear();
    await act(async () => retryButton()!.click());
    expect(rebuild).toHaveBeenCalledTimes(2);
    // Mid-retry: still the note (now saying so), and never unsettled, so nothing below it shifts.
    expect(text(status()!)).toContain('Trying again…');
    expect(settledCalls()).toEqual([false, true]);

    await act(async () => open());
    expect(rows().length).toBeGreaterThan(0);
    expect(status()).toBeNull();
    expect(settledCalls()).toEqual([false, true]);
  });
});

describe('opening a card', () => {
  const open = async (row: HTMLButtonElement) => {
    await act(async () => row.click());
    await act(async () => {});
  };

  beforeEach(() => {
    used.value = 1;
    offer(pack(0, [TOP.id, WEAK.id, WEAK.id, WEAK.id, WEAK.id], [{ holo: true }]));
  });

  it('opens the card viewer for that card with its Share card action', async () => {
    render();
    await open(rows()[0]);
    const viewer = dialog()!;
    expect(viewer).not.toBeNull();
    expect(document.getElementById(viewer.getAttribute('aria-labelledby')!)?.textContent).toBe(TOP.name);
    expect([...viewer.querySelectorAll('button')].some((b) => b.textContent?.includes('Share card'))).toBe(true);
    // The exact version: this card is a holo.
    expect(text(viewer)).toContain('Holo');
  });

  it('puts focus back on the row after Close, even where a click does not focus a button (Safari)', async () => {
    render();
    const row = rows()[0];
    await open(row);
    expect(document.activeElement).not.toBe(row);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('puts focus back on the row after Escape when the row was focused', async () => {
    render();
    const row = rows()[1];
    act(() => row.focus());
    await open(row);
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(row);
  });
});
