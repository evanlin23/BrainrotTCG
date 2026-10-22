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

describe('exact-variant proof attribution (issue #654)', () => {
  const card = getSetCards(DEFAULT_SET_ID)[0];
  const cardId = card.key.split('/')[1];

  it('queries history strictly with exactOnly: true', async () => {
    vi.mocked(findPackWithCard).mockReturnValue(null);
    const version = { isHolo: false, finish: 'SILVER' as const, misprint: false };
    await act(async () => root.render(<CardShareSheet card={card} version={version} onClose={() => {}} />));

    expect(findPackWithCard).toHaveBeenCalledWith(
      getPlayer().publicKeyHex,
      card.setId,
      cardId,
      { isHolo: false, finish: 'SILVER', misprint: false },
      { exactOnly: true },
    );
  });

  it('renders honest image-only preview without claiming card predates verifiable pulls when exact pack is missing', async () => {
    vi.mocked(findPackWithCard).mockReturnValue(null);
    const version = { isHolo: false, finish: 'SILVER' as const, misprint: false };
    await act(async () => root.render(<CardShareSheet card={card} version={version} onClose={() => {}} />));

    const note = document.querySelector('.share-note')!.textContent;
    expect(note).toContain("This device doesn't have a verified pack record for this silver card, so there's no link to prove it.");
    expect(note).not.toContain('it came before verifiable pulls');

    const poster = vi.mocked(renderCardPoster).mock.calls[0][0];
    expect(poster.url).toBeUndefined();
    expect(poster.cert).toBeUndefined();
    expect([...document.querySelectorAll('button')].some((el) => el.textContent?.includes('Copy link'))).toBe(false);
  });

  it('renders honest note for a plain card when exact record is absent', async () => {
    vi.mocked(findPackWithCard).mockReturnValue(null);
    const version = { isHolo: false, finish: null, misprint: false };
    await act(async () => root.render(<CardShareSheet card={card} version={version} onClose={() => {}} />));

    const note = document.querySelector('.share-note')!.textContent;
    expect(note).toContain("This device doesn't have a verified pack record for this card, so there's no link to prove it.");
    expect(note).not.toContain('it came before verifiable pulls');
  });

  it('rejects a from-pack whose cached cards lack the exact variant and searches history with exactOnly', async () => {
    const fromPack: PullRef = {
      setId: card.setId,
      setVersion: getLatestSet(card.setId)!.version,
      nonce: 6,
      publicKeyHex: getPlayer().publicKeyHex,
    };
    // Seed history where pack #6 has the card plain, but NOT Silver
    localStorage.setItem(
      'brainrot-history-v1',
      JSON.stringify([
        {
          s: fromPack.setId,
          v: fromPack.setVersion,
          n: 6,
          k: fromPack.publicKeyHex!.slice(0, 16),
          c: `${cardId}`, // plain only
          h: 'Pair',
          x: 100,
          t: 100,
        },
      ]),
    );

    vi.mocked(findPackWithCard).mockReturnValue(null);
    const version = { isHolo: false, finish: 'SILVER' as const, misprint: false };
    await act(async () => root.render(<CardShareSheet card={card} version={version} from={fromPack} onClose={() => {}} />));

    // Because pack #6 provably does not contain the Silver card, it was rejected
    expect(findPackWithCard).toHaveBeenCalledWith(
      getPlayer().publicKeyHex,
      card.setId,
      cardId,
      { isHolo: false, finish: 'SILVER', misprint: false },
      { exactOnly: true },
    );
    const note = document.querySelector('.share-note')!.textContent;
    expect(note).toContain("This device doesn't have a verified pack record for this silver card");
  });

  const seed = (fromPack: PullRef, c?: string) =>
    localStorage.setItem(
      'brainrot-history-v1',
      JSON.stringify([{ s: fromPack.setId, v: fromPack.setVersion, n: fromPack.nonce, k: fromPack.publicKeyHex!.slice(0, 16), ...(c === undefined ? {} : { c }), h: 'Pair', x: 100, t: 100 }]),
    );
  const fromPack = (): PullRef => ({ setId: card.setId, setVersion: getLatestSet(card.setId)!.version, nonce: 6, publicKeyHex: getPlayer().publicKeyHex });

  it('keeps a from-pack whose cached cards hold the exact variant, without searching history', async () => {
    const pack = fromPack();
    seed(pack, `${cardId}S`);
    const version = { isHolo: false, finish: 'SILVER' as const, misprint: false };
    await act(async () => root.render(<CardShareSheet card={card} version={version} from={pack} onClose={() => {}} />));

    expect(findPackWithCard).not.toHaveBeenCalled();
    const poster = vi.mocked(renderCardPoster).mock.calls[0][0];
    expect(poster.url).toBe(pullUrl(proofFor(pack)));
    expect(document.body.textContent).toContain('(ticket #6)');
  });

  it('trusts a from-pack when history has its ticket but no cached cards', async () => {
    const pack = fromPack();
    seed(pack);
    const version = { isHolo: false, finish: 'SILVER' as const, misprint: false };
    await act(async () => root.render(<CardShareSheet card={card} version={version} from={pack} onClose={() => {}} />));

    expect(findPackWithCard).not.toHaveBeenCalled();
    expect(vi.mocked(renderCardPoster).mock.calls[0][0].url).toBe(pullUrl(proofFor(pack)));
    expect(document.body.textContent).toContain('(ticket #6)');
  });
});

describe('cross-tab save switch (#653)', () => {
  const card = getSetCards(DEFAULT_SET_ID)[0];
  const cardId = card.key.split('/')[1];
  const SECRET_A = '11'.repeat(32);
  const SECRET_B = '22'.repeat(32);
  const KEY_A = toHex(publicKeyFromSecret(fromHex(SECRET_A)));
  const KEY_B = toHex(publicKeyFromSecret(fromHex(SECRET_B)));
  const PLAYER_STORAGE = 'brainrot-player-v1';
  const SAVE_STAMP = 'brainrot-save-stamp-v1';
  const store = (secret: string, name: string, nextNonce = 2) =>
    localStorage.setItem(PLAYER_STORAGE, JSON.stringify({ secretKey: secret, name, nextNonce, createdAt: 1 }));
  const pack = (key: string, nonce: number): HistoryEntry => ({
    setId: card.setId,
    setVersion: getLatestSet(card.setId)!.version,
    nonce,
    key,
    cards: [],
    hand: 'none',
    score: 0,
    openedAt: nonce + 1,
  });
  const packA = pack(KEY_A, 0);
  const packB = pack(KEY_B, 1);
  const buttons = () => [...document.querySelectorAll('button')];
  const labelled = (text: string) => buttons().find((el) => el.textContent?.includes(text));
  const otherTab = (key: string | null) => act(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
  const mount = () => act(async () => root.render(<CardShareSheet card={card} version={{ isHolo: false }} onClose={() => {}} />));
  const linkA = () => pullUrl(proofFor(packA), cardPreviewPath(card.setId, cardId));

  beforeEach(() => {
    // Both players own this card: each has a pack of it, so a sheet that followed storage would find one.
    vi.mocked(findPackWithCard).mockImplementation((playerKey) => (playerKey === KEY_A ? packA : packB));
    store(SECRET_A, 'Player A');
  });

  it('pairs A\'s poster with A\'s link, then retires every action when another tab saves player B', async () => {
    const blobA = new Blob(['posterA'], { type: 'image/png' });
    vi.mocked(renderCardPoster).mockResolvedValueOnce(blobA);
    await mount();

    expect(vi.mocked(renderCardPoster)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderCardPoster).mock.calls[0][0]).toMatchObject({ cert: expect.stringContaining('#0'), playerName: 'Player A' });
    expect(document.body.textContent).toContain('(ticket #0)');

    await act(async () => labelled('Copy link')!.click());
    expect(vi.mocked(copyText)).toHaveBeenLastCalledWith(linkA());
    await act(async () => labelled('Copy image')!.click());
    expect(vi.mocked(copyImage)).toHaveBeenLastCalledWith(blobA);
    await act(async () => labelled('Share to')!.click());
    expect(vi.mocked(shareTo)).toHaveBeenLastCalledWith(expect.objectContaining({
      url: linkA(),
      image: expect.objectContaining({ blob: blobA }),
    }));
    const calls = [vi.mocked(copyText).mock.calls.length, vi.mocked(copyImage).mock.calls.length, vi.mocked(shareTo).mock.calls.length];

    store(SECRET_B, 'Player B');
    await otherTab(PLAYER_STORAGE);

    // Nothing is left to press: no copy, save or share of A's card under B, and no redraw as B.
    for (const label of ['Copy link', 'Copy image', 'Save image', 'Copy text', 'Share to']) expect(labelled(label)).toBeUndefined();
    expect(document.querySelector('.share-sheet img')).toBeNull();
    expect(document.body.textContent).toContain('This save changed in another tab. Reload to share.');
    expect(document.body.textContent).not.toContain('(ticket #1)');
    expect(vi.mocked(renderCardPoster)).toHaveBeenCalledTimes(1);
    expect(revokedUrls).toEqual(createdUrls);
    expect([vi.mocked(copyText).mock.calls.length, vi.mocked(copyImage).mock.calls.length, vi.mocked(shareTo).mock.calls.length]).toEqual(calls);
    // B was never drawn: not for the poster and not for the proof.
    expect(vi.mocked(findPackWithCard).mock.calls.every(([key]) => key === KEY_A)).toBe(true);
  });

  it('retires a draw still in flight, so its late poster is never shown or offered', async () => {
    let resolveDrawA!: (b: Blob) => void;
    vi.mocked(renderCardPoster).mockReturnValueOnce(new Promise<Blob>((res) => { resolveDrawA = res; }));
    await mount();
    expect((labelled('Copy image') as HTMLButtonElement).disabled).toBe(true);

    store(SECRET_B, 'Player B');
    await otherTab(PLAYER_STORAGE);
    await act(async () => resolveDrawA(new Blob(['lateA'], { type: 'image/png' })));

    expect(createdUrls).toEqual([]);
    for (const label of ['Copy link', 'Copy image', 'Save image', 'Share to']) expect(labelled(label)).toBeUndefined();
    expect(document.querySelector('.share-sheet img')).toBeNull();
    expect(vi.mocked(renderCardPoster)).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Reload to share.');
  });

  it('stays retired when the first player comes back', async () => {
    await mount();
    store(SECRET_B, 'Player B');
    await otherTab(PLAYER_STORAGE);
    store(SECRET_A, 'Player A');
    await otherTab(PLAYER_STORAGE);
    expect(labelled('Copy link')).toBeUndefined();
    expect(document.body.textContent).toContain('Reload to share.');
  });

  it.each([
    ['a rename', () => store(SECRET_A, 'Renamed A'), PLAYER_STORAGE],
    ['a re-import of the same player', () => localStorage.setItem(SAVE_STAMP, 'stamp-2'), SAVE_STAMP],
    ['a cleared storage', () => undefined, null],
  ])('leaves the sheet alone for %s', async (_what, change, key) => {
    await mount();
    expect(createdUrls).toHaveLength(1);
    change();
    await otherTab(key);

    expect(vi.mocked(renderCardPoster)).toHaveBeenCalledTimes(1);
    expect(revokedUrls).toEqual([]);
    expect(labelled('Copy link')).toBeDefined();
    expect((labelled('Copy image') as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).not.toContain('Reload to share.');
  });

  it('only reads storage: another tab\'s write never makes the sheet store a player record', async () => {
    await mount();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    store(SECRET_A, 'Player A', 5);
    writes.mockClear();
    await otherTab(PLAYER_STORAGE);
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
  });

  it('releases the poster\'s object URL on unmount', async () => {
    await mount();
    expect(createdUrls).toHaveLength(1);
    expect(revokedUrls).toEqual([]);
    await act(async () => root.unmount());
    expect(revokedUrls).toEqual(createdUrls);
  });
});
