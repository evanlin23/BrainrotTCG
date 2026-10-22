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
import { copyImage, copyText, shareTo } from '../../game/shareActions';
import { cardPreviewPath } from '../../game/previewLinks';
import { fromHex, publicKeyFromSecret, toHex } from '../../engine';
import CardShareSheet from './CardShareSheet';

vi.mock('../../game/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/history')>()),
  findPackWithCard: vi.fn(),
}));
vi.mock('../../game/shareActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/shareActions')>()),
  copyText: vi.fn(async () => true),
  copyImage: vi.fn(async () => true),
  canCopyImage: vi.fn(() => true),
  canShareTo: vi.fn(() => true),
  shareTo: vi.fn(async () => 'shared'),
}));
vi.mock('../../game/bragImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/bragImage')>()),
  renderCardPoster: vi.fn(async () => new Blob(['poster'], { type: 'image/png' })),
}));

let root: Root;
let container: HTMLElement;
let createdUrls: string[] = [];
let revokedUrls: string[] = [];

beforeEach(() => {
  createdUrls = [];
  revokedUrls = [];
  let urlCounter = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom has no object URLs; track created and revoked URLs.
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() {
      const u = `blob:poster-${++urlCounter}`;
      createdUrls.push(u);
      return u;
    }
    static revokeObjectURL(u: string) {
      revokedUrls.push(u);
    }
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

describe('cross-tab save switch and draw lifecycle (#653)', () => {
  const card = getSetCards(DEFAULT_SET_ID)[0];
  const cardId = card.key.split('/')[1];
  const SECRET_A = '11'.repeat(32);
  const SECRET_B = '22'.repeat(32);
  const KEY_A = toHex(publicKeyFromSecret(fromHex(SECRET_A)));
  const KEY_B = toHex(publicKeyFromSecret(fromHex(SECRET_B)));

  it('atomically regenerates image, cert, QR and link when save switches after draw A completes', async () => {
    // Seed Player A as current save
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: SECRET_A, name: 'Player A', nextNonce: 1, createdAt: 1 }));

    const packA: HistoryEntry = {
      setId: card.setId,
      setVersion: getLatestSet(card.setId)!.version,
      nonce: 0,
      key: KEY_A,
      cards: [],
      hand: 'none',
      score: 0,
      openedAt: 1,
    };
    const packB: HistoryEntry = {
      setId: card.setId,
      setVersion: getLatestSet(card.setId)!.version,
      nonce: 1,
      key: KEY_B,
      cards: [],
      hand: 'none',
      score: 0,
      openedAt: 2,
    };

    vi.mocked(findPackWithCard).mockImplementation((playerKey) => playerKey === KEY_A ? packA : packB);

    const blobA = new Blob(['posterA'], { type: 'image/png' });
    const blobB = new Blob(['posterB'], { type: 'image/png' });
    vi.mocked(renderCardPoster).mockResolvedValueOnce(blobA);

    await act(async () => root.render(<CardShareSheet card={card} version={{ isHolo: false }} onClose={() => {}} />));

    // Player A's draw completed
    expect(vi.mocked(renderCardPoster)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderCardPoster).mock.calls[0][0].cert).toContain('#0');
    expect(document.body.textContent).toContain('(ticket #0)');

    // Copy link on A
    const copyLinkBtn = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copy link'))!;
    await act(async () => copyLinkBtn.click());
    const proofA = proofFor(packA);
    expect(vi.mocked(copyText)).toHaveBeenLastCalledWith(pullUrl(proofA, cardPreviewPath(card.setId, cardId)));

    // Copy image on A
    const copyImageBtn = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copy image'))!;
    await act(async () => copyImageBtn.click());
    expect(vi.mocked(copyImage)).toHaveBeenLastCalledWith(blobA);

    // Native share on A
    const shareToBtn = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Share to'))!;
    await act(async () => shareToBtn.click());
    expect(vi.mocked(shareTo)).toHaveBeenLastCalledWith(expect.objectContaining({
      url: pullUrl(proofA, cardPreviewPath(card.setId, cardId)),
      image: expect.objectContaining({ blob: blobA }),
    }));

    // Now another tab imports Player B, who also owns this card (ticket #1)
    vi.mocked(renderCardPoster).mockResolvedValueOnce(blobB);
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: SECRET_B, name: 'Player B', nextNonce: 2, createdAt: 2 }));
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-player-v1' }));
    });

    // Player B's snapshot is now active
    expect(vi.mocked(renderCardPoster)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(renderCardPoster).mock.calls[1][0].cert).toContain('#1');
    expect(document.body.textContent).toContain('(ticket #1)');

    // Old object URL was revoked, new one created
    expect(revokedUrls.length).toBeGreaterThanOrEqual(1);

    // Copy link on B uses B's newly signed proof (ticket #1) on the active sheet
    const activeCopyLinkBtn = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copy link'))!;
    await act(async () => activeCopyLinkBtn.click());
    const proofB = proofFor(packB);
    expect(vi.mocked(copyText)).toHaveBeenLastCalledWith(pullUrl(proofB, cardPreviewPath(card.setId, cardId)));

    // Copy image on B uses B's blob
    const activeCopyImageBtn = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copy image'))!;
    await act(async () => activeCopyImageBtn.click());
    expect(vi.mocked(copyImage)).toHaveBeenLastCalledWith(blobB);

    // Native share on B uses B's link AND B's blob
    const activeShareToBtn = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Share to'))!;
    await act(async () => activeShareToBtn.click());
    expect(vi.mocked(shareTo)).toHaveBeenLastCalledWith(expect.objectContaining({
      url: pullUrl(proofB, cardPreviewPath(card.setId, cardId)),
      image: expect.objectContaining({ blob: blobB }),
    }));
  });

  it('cancels in-flight draw A on save switch so late completion cannot contaminate B snapshot', async () => {
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: SECRET_A, name: 'Player A', nextNonce: 1, createdAt: 1 }));

    const packA: HistoryEntry = {
      setId: card.setId,
      setVersion: getLatestSet(card.setId)!.version,
      nonce: 0,
      key: KEY_A,
      cards: [],
      hand: 'none',
      score: 0,
      openedAt: 1,
    };
    const packB: HistoryEntry = {
      setId: card.setId,
      setVersion: getLatestSet(card.setId)!.version,
      nonce: 1,
      key: KEY_B,
      cards: [],
      hand: 'none',
      score: 0,
      openedAt: 2,
    };
    vi.mocked(findPackWithCard).mockImplementation((playerKey) => playerKey === KEY_A ? packA : packB);

    let resolveDrawA!: (b: Blob) => void;
    const pendingDrawA = new Promise<Blob>((res) => { resolveDrawA = res; });
    let resolveDrawB!: (b: Blob) => void;
    const pendingDrawB = new Promise<Blob>((res) => { resolveDrawB = res; });

    vi.mocked(renderCardPoster).mockReturnValueOnce(pendingDrawA).mockReturnValueOnce(pendingDrawB);

    await act(async () => root.render(<CardShareSheet card={card} version={{ isHolo: false }} onClose={() => {}} />));

    // A's draw is in-flight: Copy image is disabled
    const copyImageBtn = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copy image'))!;
    expect(copyImageBtn.hasAttribute('disabled')).toBe(true);

    // Storage switches to Player B before A's draw resolves
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: SECRET_B, name: 'Player B', nextNonce: 2, createdAt: 2 }));
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-player-v1' }));
    });

    // Now late resolve of Draw A
    const blobA = new Blob(['lateA'], { type: 'image/png' });
    await act(async () => resolveDrawA(blobA));

    // A's late blob was ignored; copy image on active sheet is still disabled because B is drawing
    const activeCopyImageDuringB = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copy image'))!;
    expect(activeCopyImageDuringB.hasAttribute('disabled')).toBe(true);

    // Now B's draw resolves
    const blobB = new Blob(['posterB'], { type: 'image/png' });
    await act(async () => resolveDrawB(blobB));

    const activeCopyImageAfterB = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copy image'))!;
    expect(activeCopyImageAfterB.hasAttribute('disabled')).toBe(false);
    await act(async () => activeCopyImageAfterB.click());
    expect(vi.mocked(copyImage)).toHaveBeenLastCalledWith(blobB);

    const shareToBtn = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Share to'))!;
    await act(async () => shareToBtn.click());
    const proofB = proofFor(packB);
    expect(vi.mocked(shareTo)).toHaveBeenLastCalledWith(expect.objectContaining({
      url: pullUrl(proofB, cardPreviewPath(card.setId, cardId)),
      image: expect.objectContaining({ blob: blobB }),
    }));
  });

  it('releases object URLs upon replacement and on unmount', async () => {
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: SECRET_A, name: 'Player A', nextNonce: 1, createdAt: 1 }));
    vi.mocked(findPackWithCard).mockReturnValue(null);
    vi.mocked(renderCardPoster).mockResolvedValue(new Blob(['poster'], { type: 'image/png' }));

    await act(async () => root.render(<CardShareSheet card={card} version={{ isHolo: false }} onClose={() => {}} />));
    expect(createdUrls.length).toBe(1);
    expect(revokedUrls.length).toBe(0);

    // Switch player
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: SECRET_B, name: 'Player B', nextNonce: 2, createdAt: 2 }));
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-player-v1' }));
    });

    // First URL was revoked, second URL created
    expect(createdUrls.length).toBe(2);
    expect(revokedUrls).toContain(createdUrls[0]);

    // Unmount
    await act(async () => root.unmount());
    expect(revokedUrls).toContain(createdUrls[1]);
  });
});
