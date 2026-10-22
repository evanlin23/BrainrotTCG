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
import { cardPreviewPath } from '../../game/previewLinks';
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

describe('the link a card shares', () => {
  const linkFor = async (setId: string, version: { isHolo: boolean; finish?: 'GOLD' | 'SILVER' | null; misprint?: boolean }) => {
    const card = getSetCards(setId)[0];
    const pack: PullRef = { setId, setVersion: getLatestSet(setId)!.version, nonce: 3, publicKeyHex: getPlayer().publicKeyHex };
    await act(async () => root.render(<CardShareSheet card={card} version={version} from={pack} onClose={() => {}} />));
    const copy = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copy text'))!;
    await act(async () => copy.click());
    const calls = vi.mocked(copyText).mock.calls;
    return { link: calls[calls.length - 1][0].split('\n')[2], card, proof: proofFor(pack) };
  };

  it("goes through the page naming the card's rarest modifier", async () => {
    const { link, card, proof } = await linkFor(DEFAULT_SET_ID, { isHolo: true, finish: 'SILVER', misprint: true });
    expect(link).toBe(pullUrl(proof, cardPreviewPath(card.setId, card.key.split('/')[1], 'MISPRINT')));
  });

  it("keeps the card's plain page without a modifier, or in a set without modifier pages", async () => {
    const plain = await linkFor(DEFAULT_SET_ID, { isHolo: false, finish: null, misprint: false });
    expect(plain.link).toBe(pullUrl(plain.proof, cardPreviewPath(plain.card.setId, plain.card.key.split('/')[1])));
    act(() => root.unmount());
    root = createRoot(container);
    const genesis = await linkFor('genesis', { isHolo: true });
    expect(genesis.link).toBe(pullUrl(genesis.proof, cardPreviewPath('genesis', genesis.card.key.split('/')[1])));
  });
});

describe('native sharing failure recovery for card shares', () => {
  const bukangi = getSetCards(DEFAULT_SET_ID).find((c) => c.name === 'Bukangi') ?? getSetCards(DEFAULT_SET_ID)[0];
  let shareMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    shareMock = vi.fn();
    vi.stubGlobal('navigator', {
      share: shareMock,
      canShare: vi.fn(() => true),
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }));
  });

  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.share-sheet button')].find((el) =>
      el.textContent?.trim().includes(label),
    )!;
  const done = () => document.querySelector('.share-done')!.textContent;
  const isDoneFailed = () => document.querySelector('.share-done')!.classList.contains('is-failed');

  it('shows failure feedback and directs to alternatives when native sharing fails for a card without proof URL', async () => {
    // Injected native outcome: navigator.share rejects with NotAllowedError (permission denied)
    shareMock.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    vi.mocked(findPackWithCard).mockReturnValue(null);

    await act(async () => root.render(<CardShareSheet card={bukangi} version={{ isHolo: false }} onClose={() => {}} />));

    expect(document.body.textContent).toContain("so there's no link to prove it");
    const shareBtn = button('Share to…');
    expect(shareBtn).toBeDefined();

    await act(async () => shareBtn.click());

    expect(shareMock).toHaveBeenCalledTimes(1);
    expect(done()).toBe('Sharing failed — use Save image or Copy text');
    expect(isDoneFailed()).toBe(true);
    expect(vi.mocked(copyText)).not.toHaveBeenCalled();
  });

  it('falls back to copying proof link when native sharing fails for a card with pack history', async () => {
    // Injected native outcome: navigator.share rejects with NotAllowedError
    shareMock.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    const pack: PullRef = { setId: bukangi.setId, setVersion: getLatestSet(bukangi.setId)!.version, nonce: 42, publicKeyHex: getPlayer().publicKeyHex };

    await act(async () => root.render(<CardShareSheet card={bukangi} version={{ isHolo: false }} from={pack} onClose={() => {}} />));

    const shareBtn = button('Share to…');
    await act(async () => shareBtn.click());

    expect(shareMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(copyText)).toHaveBeenCalledWith(expect.stringContaining('#/pull/'));
    expect(done()).toBe('Link copied');
    expect(isDoneFailed()).toBe(false);
  });

  it('remains quiet on user cancellation (AbortError) without claiming success or copying', async () => {
    // Injected native outcome: navigator.share rejects with AbortError (user dismissed share sheet)
    shareMock.mockRejectedValue(new DOMException('Share canceled', 'AbortError'));
    vi.mocked(findPackWithCard).mockReturnValue(null);

    await act(async () => root.render(<CardShareSheet card={bukangi} version={{ isHolo: false }} onClose={() => {}} />));

    const shareBtn = button('Share to…');
    await act(async () => shareBtn.click());

    expect(shareMock).toHaveBeenCalledTimes(1);
    expect(done()).toBe('');
    expect(isDoneFailed()).toBe(false);
    expect(vi.mocked(copyText)).not.toHaveBeenCalled();
  });

  it('allows retry and clears failure feedback when a retry attempt succeeds', async () => {
    // First attempt rejects with NotAllowedError, second attempt succeeds
    shareMock.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
    vi.mocked(findPackWithCard).mockReturnValue(null);

    await act(async () => root.render(<CardShareSheet card={bukangi} version={{ isHolo: false }} onClose={() => {}} />));

    const shareBtn = button('Share to…');
    await act(async () => shareBtn.click());
    expect(done()).toBe('Sharing failed — use Save image or Copy text');
    expect(isDoneFailed()).toBe(true);

    shareMock.mockResolvedValueOnce(undefined);
    await act(async () => shareBtn.click());

    expect(shareMock).toHaveBeenCalledTimes(2);
    expect(done()).toBe('');
    expect(isDoneFailed()).toBe(false);
  });
});
