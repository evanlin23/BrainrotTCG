// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLatestSet, DEFAULT_SET_ID } from '../../content/sets';
import { getSetCards } from '../../data/cards';
import { findPackWithCard, type HistoryEntry } from '../../game/history';
import { renderCardPoster } from '../../game/bragImage';
import { getPlayer } from '../../game/player';
import { proofFor, pullUrl, type PullRef } from '../../game/pulls';
import { cardStats } from '../../game/cardStats';
import { copyText } from '../../game/shareActions';
import CardShareSheet from './CardShareSheet';

vi.mock('../../game/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/history')>()),
  findPackWithCard: vi.fn(),
}));
vi.mock('../../game/shareActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/shareActions')>()),
  copyText: vi.fn(async () => true),
}));
vi.mock('../../game/bragImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/bragImage')>()),
  renderCardPoster: vi.fn(async () => new Blob(['poster'], { type: 'image/png' })),
}));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom has no object URLs; the preview only needs a string for the <img>.
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:poster'; }
    static revokeObjectURL() {}
  });
  localStorage.clear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('sharing a card from the first ticket', () => {
  it('still names the card and links its pack when the pack nonce is 0', async () => {
    const card = getSetCards(DEFAULT_SET_ID)[0];
    const pack: HistoryEntry = {
      setId: card.setId,
      setVersion: getLatestSet(card.setId)!.version,
      nonce: 0,
      key: getPlayer().publicKeyHex.slice(0, 16),
      cards: [],
      hand: 'none',
      score: 0,
      openedAt: 1,
    };
    vi.mocked(findPackWithCard).mockReturnValue(pack);

    await act(async () => root.render(<CardShareSheet card={card} version={{ isHolo: false }} onClose={() => {}} />));

    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(`Share ${card.name}`);
    expect(renderCardPoster).toHaveBeenCalledTimes(1);
    const poster = vi.mocked(renderCardPoster).mock.calls[0][0];
    expect(poster.card.name).toBe(card.name);
    expect(poster.cert).toMatch(/ #0$/);
    expect(poster.url).toContain('#/pull/');
    expect(document.body.textContent).toContain('(ticket #0)');
    expect([...document.querySelectorAll('button')].some((el) => el.textContent?.includes('Copy link'))).toBe(true);
  });
});

describe('sharing a card from the pack summary', () => {
  const card = getSetCards(DEFAULT_SET_ID)[1];
  const from = (): PullRef => ({ setId: card.setId, setVersion: getLatestSet(card.setId)!.version, nonce: 7, publicKeyHex: getPlayer().publicKeyHex });

  it('links the pack it came in, with the same link as that pack\'s Share', async () => {
    const pack = from();
    await act(async () => root.render(<CardShareSheet card={card} version={{ isHolo: false }} from={pack} onClose={() => {}} />));

    expect(findPackWithCard).not.toHaveBeenCalled();
    const poster = vi.mocked(renderCardPoster).mock.calls[0][0];
    expect(poster.url).toBe(pullUrl(proofFor(pack)));
    expect(poster.cert).toMatch(/ #7$/);
    expect(document.body.textContent).toContain('(ticket #7)');
  });

  it('looks the card up in the history when that pack was opened with another key', async () => {
    vi.mocked(findPackWithCard).mockReturnValue(null);
    const other = { ...from(), publicKeyHex: 'ff'.repeat(32) };
    await act(async () => root.render(<CardShareSheet card={card} version={{ isHolo: false }} from={other} onClose={() => {}} />));

    expect(findPackWithCard).toHaveBeenCalled();
  });
});

describe('the per-card share text and poster', () => {
  it('lead with the rarity mark, the version, the points and the pack odds', async () => {
    vi.mocked(findPackWithCard).mockReturnValue(null);
    const card = getSetCards(DEFAULT_SET_ID)[0];
    const version = { isHolo: true, finish: 'GOLD' as const, misprint: false };
    await act(async () => root.render(<CardShareSheet card={card} version={version} onClose={() => {}} />));

    const stats = cardStats(card, version).line;
    expect(vi.mocked(renderCardPoster).mock.calls[0][0].stats).toBe(stats);
    const copy = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copy text'))!;
    await act(async () => copy.click());
    const [first, second] = vi.mocked(copyText).mock.calls[0][0].split('\n');
    expect(first).toMatch(new RegExp(`^\\S+ ${card.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · Gold Holo \\w+ · `));
    expect(first.endsWith(` · ${stats}`)).toBe(true);
    expect(second).toBe(`${getLatestSet(card.setId)!.name} in Brainrot TCG`);
  });
});
