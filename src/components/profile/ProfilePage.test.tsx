// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage';
import ProfileSummary from './ProfileSummary';
import { DEFAULT_SETTINGS } from '../../utils/settings';
import { ACHIEVEMENTS } from '../../data/achievements';
import { getSet } from '../../content/sets';
import { HALL_OF_FAME_MIN_MULTIPLIER, POKER_HANDS, XP_PER_HAND, XP_PER_NEW_CARD, XP_PER_PACK, pullId, scorePulled, xpForLevel, type ProfilePack, type ProfileStats } from '../../engine';
import { toPulled } from '../../game/cardCode';
import { getPlayer, PLAYER_STORAGE_KEY } from '../../game/player';
import { resetBestCards } from '../../game/bestCards';
import { STORAGE_KEYS } from '../../constants';
import { toCardsWithMeta } from '../../game/pulls';
import { scoreCards } from '../../data/cards';
import { resetSubmissionsForTest, submitToHallOfFame, SUBMITTED_KEY } from '../../game/share';

const { myProfileInfo, myProfileProof, myStats, myPackCacheState, hydrateMyPacks } = vi.hoisted(() => ({
  myProfileInfo: vi.fn(), myProfileProof: vi.fn(), myStats: vi.fn(), myPackCacheState: vi.fn(), hydrateMyPacks: vi.fn(),
}));
vi.mock('../../game/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/profiles')>()),
  myProfileInfo,
  myProfileProof,
  myStats,
}));
vi.mock('../../game/packCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/packCache')>()),
  myPackCacheState,
  hydrateMyPacks,
}));
const actual = await vi.importActual<typeof import('../../game/profiles')>('../../game/profiles');
const { getHistory } = vi.hoisted(() => ({ getHistory: vi.fn() }));
vi.mock('../../game/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/history')>()),
  getHistory,
}));
const actualHistory = await vi.importActual<typeof import('../../game/history')>('../../game/history');
// The engine checks are BestHighlights' own tests (and bestSources'): here they settle as each test says.
const { checkBestPack, checkBestCard } = vi.hoisted(() => ({ checkBestPack: vi.fn(), checkBestCard: vi.fn() }));
vi.mock('../../game/bestSources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/bestSources')>()),
  checkBestPack,
  checkBestCard,
}));

// The Best card place is held only while BestCardsSection is unsettled: record what BestHighlights is told.
const { expectingSeen, rebuildBestCards } = vi.hoisted(() => ({ expectingSeen: vi.fn(), rebuildBestCards: vi.fn() }));
vi.mock('./BestHighlights', async (importOriginal) => {
  const Real = (await importOriginal<typeof import('./BestHighlights')>()).default;
  return {
    default: (props: React.ComponentProps<typeof Real>) => {
      expectingSeen(props.expecting);
      return <Real {...props} />;
    },
  };
});
// Rebuilding mines Argon2id tickets: a test releases (or never releases) it by hand.
vi.mock('../../game/bestCards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/bestCards')>()),
  rebuildBestCards,
}));
const actualBestCards = await vi.importActual<typeof import('../../game/bestCards')>('../../game/bestCards');

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver; the profile card's Sheet only uses it to track overflow.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  resetSubmissionsForTest();
  myProfileInfo.mockReset().mockReturnValue({ packs: 3, filled: 0, missing: 0, cache: 'ready' });
  myProfileProof.mockReset();
  myStats.mockReset().mockImplementation(actual.myStats);
  myPackCacheState.mockReset().mockReturnValue('ready');
  hydrateMyPacks.mockReset().mockResolvedValue('ready');
  getHistory.mockReset().mockImplementation(actualHistory.getHistory);
  checkBestPack.mockReset().mockReturnValue(new Promise(() => {}));
  checkBestCard.mockReset().mockReturnValue(new Promise(() => {}));
  expectingSeen.mockReset();
  rebuildBestCards.mockReset().mockImplementation(actualBestCards.rebuildBestCards);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  resetSubmissionsForTest();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.doUnmock('../../game/nostrInbox');
});

const render = (props: Partial<Parameters<typeof ProfilePage>[0]> = {}) =>
  act(() =>
    root.render(
      <ProfilePage
        stats={{}}
        level={1}
        settings={DEFAULT_SETTINGS}
        onSettingsChange={() => {}}
        unlockedAchievements={{}}
        onSharePull={() => {}}
        onSharePack={() => {}}
        onOpenSave={() => {}}
        onOpenPacks={() => {}}
        canSave={() => true}
        onSaveFailed={() => {}}
        {...props}
      />,
    ),
  );
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.includes(label))!;
const alert = () => document.querySelector<HTMLElement>('[role="alert"]');

describe('profile link failures', () => {
  it.each(['Copy profile link', 'Profile card'])('shows why %s failed when another tab changed the save, and can retry', async (label) => {
    myProfileProof.mockRejectedValueOnce(new Error('Your save changed while the profile link was being prepared. Try again.'));
    render();
    await act(async () => button(label).click());
    expect(alert()?.textContent).toContain('Your save changed while the profile link was being prepared.');
    expect(alert()?.textContent).toContain('try again once it finishes');
    expect(button(label).disabled).toBe(false);

    // The next attempt clears the old error.
    myProfileProof.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => button(label).click());
    expect(alert()).toBeNull();
    expect(myProfileProof).toHaveBeenCalledTimes(2);
  });

  it('recounts what a link can prove when another tab records a pack', () => {
    render();
    expect(myProfileInfo).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-settings-v1' })));
    expect(myProfileInfo).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-history-v1' })));
    expect(myProfileInfo).toHaveBeenCalledTimes(2);
  });

  it.each([
    [1, 'for 1 pack.'],
    [1234, `for ${(1234).toLocaleString()} packs.`],
  ])('counts the %i packs that cannot be linked and points to the private recovery options', (filled, count) => {
    myProfileInfo.mockReturnValue({ packs: filled + 2, filled, missing: 0, cache: 'ready' });
    render();
    const text = document.body.textContent!;
    expect(text).toContain(`Original set/version records are missing or unavailable ${count}`);
    expect(text).toContain('Keep a private export (open Settings, then Save & backup)');
    expect(text).toContain('an older complete backup, it may contain the missing records');
  });

  it('says nothing about unlinkable packs when every ticket has its original mapping', () => {
    render();
    expect(document.body.textContent).not.toContain('missing or unavailable');
  });

  it('refuses only the link and profile card when a ticket has no original mapping', () => {
    myProfileInfo.mockReturnValue({ packs: 3, filled: 1, missing: 2, cache: 'ready' });
    render();
    expect(button('Copy profile link').disabled).toBe(true);
    expect(button('Profile card').disabled).toBe(true);
    expect(document.body.textContent).toContain('A complete profile link or card cannot be created from this save.');
    expect(document.body.textContent).toContain('Keep a private export (open Settings, then Save & backup)');
    expect(document.body.textContent).not.toMatch(/from Settings/);
    expect(button('Re-open them').disabled).toBe(false);
  });
});

describe('saved packs still being read', () => {
  it('shows loading, then a failed read with a retry, but never zero or a re-open prompt', () => {
    myProfileInfo.mockReturnValue({ packs: 3, filled: 0, missing: 3, cache: 'loading' });
    myStats.mockReturnValue(null);
    myPackCacheState.mockReturnValue('loading');
    render();
    expect(document.querySelector('.pulls-note [role="status"]')?.textContent).toContain('Reading your saved packs');
    expect(document.querySelector('.profile-summary')).toBeNull();
    expect(document.body.textContent).not.toContain("don't have their cards on this device");

    myProfileInfo.mockReturnValue({ packs: 3, filled: 0, missing: 3, cache: 'failed' });
    myPackCacheState.mockReturnValue('failed');
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect(alert()?.textContent).toContain("Couldn't read your saved packs on this device just now");
    expect(document.querySelector('.profile-summary')).toBeNull();
    act(() => button('Try again').click());
    expect(hydrateMyPacks).toHaveBeenCalledTimes(1);
    expect(button('Re-open the packs instead').disabled).toBe(false);
  });
});

describe('pack list order and Rankings wording', () => {
  const entry = (hand: string, score: number, openedAt: number) => ({
    setId: 'genesis', setVersion: 1, nonce: openedAt, key: 'abcdef0123456789', cards: null, hand, score, openedAt,
  });
  const hands = () => [...document.querySelectorAll('.pull-row-hand')].map((el) => el.firstChild?.textContent);
  const tab = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) => el.textContent?.startsWith(label))!;

  it('lists the best packs first, then newest on request, and names the Rankings filter plainly', () => {
    // Stored newest first: the oldest pack is the best one.
    getHistory.mockReturnValue([entry('Pair', 100, 3000), entry('Two Pair', 300, 2000), entry('Full House', 900, 1000)]);
    render();
    expect([...document.querySelectorAll('[role="tab"]')].map((el) => el.textContent)).toEqual(['Best', 'Newest', 'For Rankings · 1']);
    expect(tab('Best').getAttribute('aria-selected')).toBe('true');
    expect(hands()).toEqual(['Full House', 'Two Pair', 'Pair']);
    expect(document.querySelector('.pull-row-hand .sr-only')?.textContent).toBe(', qualifies for Rankings');

    act(() => tab('Newest').click());
    expect(hands()).toEqual(['Pair', 'Two Pair', 'Full House']);

    act(() => tab('For Rankings').click());
    expect(hands()).toEqual(['Full House']);
    expect(document.querySelector('.pulls-note')?.textContent).toBe('These qualify for Rankings, the public Hall of Fame. Open one to share it or submit it.');
  });

  describe('with a long history', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => entry(i % 2 ? 'Pair' : 'Full House', 100 + i, 1000 + i));
    const rowCount = () => document.querySelectorAll('section[aria-labelledby="pulls-history-title"] .pulls-list > li').length;
    const more = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Show more'));
    const scores = () => [...document.querySelectorAll('.pull-row-score')].map((el) => el.textContent);
    const pullRows = () => [...document.querySelectorAll<HTMLButtonElement>('section[aria-labelledby="pulls-history-title"] .pulls-list > li > .pull-row')];

    it('starts with five rows and the remaining count, and Show more adds the rest', () => {
      getHistory.mockReturnValue(many(35));
      render();
      expect(rowCount()).toBe(5);
      expect(more()?.textContent).toContain('30 remaining');
      act(() => more()!.click());
      expect(rowCount()).toBe(35);
      expect(more()).toBeUndefined();
    });

    it('keeps every entry reachable in order through sorts and filters, and starts over with five', () => {
      const all = many(35);
      getHistory.mockReturnValue(all);
      render();
      // Best: highest score first; the five shown are the five best of all 35.
      const bestScores = all.map((e) => e.score).sort((a, b) => b - a).map((n) => String(n));
      expect(scores()).toEqual(bestScores.slice(0, 5));
      act(() => more()!.click());
      expect(scores()).toEqual(bestScores);
      act(() => tab('Newest').click());
      expect(rowCount()).toBe(5);
      expect(hands()).toEqual(all.slice(0, 5).map((e) => e.hand));
      act(() => tab('For Rankings').click());
      const worthy = all.filter((e) => e.hand === 'Full House').length;
      expect(rowCount()).toBe(5);
      expect(more()?.textContent).toContain(`${worthy - 5} remaining`);
      act(() => more()!.click());
      expect(rowCount()).toBe(worthy);
    });

    it('moves focus to the first new row you can open after Show more, which may remove the button that had it', () => {
      const set = getSet('right-now', 1)!;
      const saved = [{ id: set.cards[0].id, holo: false }];
      // Best order is by score: rows 0-5 (the new row 5 can't be opened: no saved cards), then 6 onward can.
      getHistory.mockReturnValue(
        Array.from({ length: 35 }, (_, i) => ({ ...entry('Pair', 1000 - i, 1000 + i), setId: 'right-now', cards: i === 5 ? null : saved })),
      );
      render();
      more()!.focus();
      expect(document.activeElement).toBe(more());
      act(() => more()!.click());
      expect(more()).toBeUndefined();
      expect(pullRows()[5].disabled).toBe(true);
      expect(document.activeElement).toBe(pullRows()[6]);
    });

    it('moves focus to the section heading when no new row can be opened', () => {
      getHistory.mockReturnValue(many(35)); // no saved cards: every row is disabled
      render();
      more()!.focus();
      act(() => more()!.click());
      expect(pullRows().every((b) => b.disabled)).toBe(true);
      expect(document.activeElement).toBe(document.getElementById('pulls-history-title'));
    });

    it('shows no Show more for a short history', () => {
      getHistory.mockReturnValue(many(5));
      render();
      expect(rowCount()).toBe(5);
      expect(more()).toBeUndefined();
    });
  });

  it('says what qualifies for Rankings when nothing does yet', () => {
    getHistory.mockReturnValue([entry('Pair', 100, 3000)]);
    render();
    act(() => tab('For Rankings').click());
    expect(document.querySelector('.pulls-note')?.textContent).toMatch(/^None yet: a Full House or better, or a Brainrot Score of [\d,]+\+, qualifies for Rankings\.$/);
  });
});

describe('the page', () => {
  it('holds the player, Achievements and the pack list under one heading level', () => {
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: 'cd'.repeat(32), name: 'Original Player', nextNonce: 4, createdAt: 1 }));
    render();
    const headings = [...document.querySelectorAll('h2')].map((el) => el.textContent);
    expect(headings).toEqual(expect.arrayContaining(['Level and stats', 'Achievements', 'Card back and foil']));
    // The name heads the page, once: no subtitle repeats it.
    expect(headings[0]).toBe('Original Player');
    expect(document.querySelector('.page-subtitle')).toBeNull();
    expect(headings.indexOf('Achievements')).toBeLessThan(headings.indexOf('Card back and foil'));
    expect(document.querySelector('h3#achievements-title, h1')).toBeNull();
    expect(document.getElementById('achievements')).not.toBeNull();
  });

  it('sends the empty profile to the packs screen and the closing footnote to Save & backup', () => {
    myProfileInfo.mockReturnValue(null);
    myStats.mockReturnValue(null);
    const onOpenPacks = vi.fn();
    const onOpenSave = vi.fn();
    render({ onOpenPacks, onOpenSave });
    act(() => button('Open your first pack').click());
    expect(onOpenPacks).toHaveBeenCalledTimes(1);
    const note = document.querySelector('.profile-page')!.lastElementChild!;
    expect(note.textContent).toBe('Saved in this browser ·Back up');
    act(() => note.querySelector('button')!.click());
    expect(onOpenSave).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('Back up your save');
  });
});

describe('folded sections', () => {
  const unlocked = Object.fromEntries(ACHIEVEMENTS.slice(0, 5).map((a, i) => [a.id, 1000 + i]));
  const all = () => document.querySelector<HTMLDetailsElement>('#achievements details')!;
  const rewards = () => document.querySelector<HTMLDetailsElement>('#rewards details')!;
  const names = (el: Element) => [...el.querySelectorAll('.achievement-name')].map((n) => n.textContent);

  it('shows the three newest achievements, with the rest folded under "Show all"', () => {
    render({ unlockedAchievements: unlocked });
    const section = document.getElementById('achievements')!;
    expect(section.querySelector('.achievements-count')!.textContent).toContain(`5/${ACHIEVEMENTS.length} unlocked`);
    const recent = section.querySelector('.achievements-group')!;
    expect(names(recent)).toEqual(ACHIEVEMENTS.slice(2, 5).map((a) => a.name).reverse());
    expect(all().open).toBe(false);
    expect(all().querySelector('summary')!.textContent).toBe(`Show all achievements (${ACHIEVEMENTS.length})`);
    expect(names(all())).toEqual(expect.arrayContaining(ACHIEVEMENTS.slice(0, 2).map((a) => a.name)));
  });

  it('opens Show all when a link or toast asks for #achievements, and again for a later request', () => {
    render({ unlockedAchievements: unlocked, section: { id: 'achievements', n: 1 } });
    expect(all().open).toBe(true);
    expect(rewards().open).toBe(false);
    act(() => {
      all().open = false;
      all().dispatchEvent(new Event('toggle'));
    });
    render({ unlockedAchievements: unlocked, section: { id: 'achievements', n: 2 } });
    expect(all().open).toBe(true);
  });

  it('keeps the card backs and foils folded, with a summary of what is unlocked, until asked for', () => {
    render();
    expect(rewards().open).toBe(false);
    expect(rewards().querySelector('summary')!.textContent).toMatch(/^\d+ of \d+ unlocked$/);
    render({ level: 99 });
    expect(rewards().querySelector('summary')!.textContent).toBe('Every reward unlocked');
    render({ section: { id: 'rewards', n: 1 } });
    expect(rewards().open).toBe(true);
  });
});

describe('Hall of Fame submitted badge', () => {
  const entry = (nonce: number, score: number, hand = 'Pair') =>
    ({ setId: 'right-now', setVersion: 1, nonce, key: getPlayer().publicKeyHex.slice(0, 16), cards: null, hand, score, openedAt: 1000 + nonce });
  const badges = () => [...document.querySelectorAll('.pull-row-sent')].map((el) => el.textContent);
  const idOf = (nonce: number) => pullId({ setId: 'right-now', setVersion: 1, publicKey: getPlayer().publicKey, nonce });

  it('shows Not submitted, Sending… and Submitted live, and nothing on packs that cannot qualify', async () => {
    let resolve!: (v: { accepted: string | null }) => void;
    const accepted = { promise: new Promise<{ accepted: string | null }>((r) => { resolve = r; }), resolve: (v: { accepted: string | null }) => resolve(v) };
    vi.doMock('../../game/nostrInbox', () => ({
      hallOfFameEvent: () => ({}),
      publishUntilAccepted: () => accepted.promise,
    }));
    getHistory.mockReturnValue([entry(1, 1e9), entry(2, 1)]);
    render();
    expect(badges()).toEqual(['Not submitted']);

    let sent!: Promise<boolean>;
    act(() => { sent = submitToHallOfFame('proof', idOf(1)); });
    await vi.waitFor(() => expect(badges()).toEqual(['Sending…']));

    accepted.resolve({ accepted: 'wss://relay' });
    await act(async () => { await sent; });
    expect(badges()).toEqual(['Submitted']);
    expect(document.querySelector('.pull-row-sent')!.getAttribute('title')).toBe('Sent from this device');
    expect(document.querySelector('.pull-row-sent svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it("shows no badge on another player's pack, even with the same set and nonce", () => {
    getHistory.mockReturnValue([{ ...entry(1, 1e9), key: 'b'.repeat(16) }]);
    render();
    expect(badges()).toEqual([]);
  });

  it('shows no badge on a pack with no recorded key', () => {
    getHistory.mockReturnValue([{ ...entry(1, 1e9), key: '' }]);
    render();
    expect(badges()).toEqual([]);
  });

  it('updates submitted badges live when another tab records a submission in storage or clears storage', () => {
    getHistory.mockReturnValue([entry(1, 1e9)]);
    render();
    expect(badges()).toEqual(['Not submitted']);

    // Another tab completes a submission
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify([idOf(1)]));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SUBMITTED_KEY }));
    });
    expect(badges()).toEqual(['Submitted']);

    // Another tab clears storage
    localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(badges()).toEqual(['Not submitted']);
  });
});

describe('Best pack highlight', () => {
  const SET = getSet('right-now', 1)!;
  const NONCE = 7;
  const bestPack = (cardIds: string[], nonce = NONCE): ProfilePack => {
    const cards = toPulled(cardIds.map((id) => ({ id, holo: false })), SET)!;
    return { nonce, set: SET, cards, score: scorePulled(cards) };
  };
  const five = bestPack(Array(SET.packSize).fill(SET.cards[0].id));
  const statsWith = (best: ProfilePack[]): ProfileStats => ({
    packs: best.length, xp: 0, level: 1, uniqueBySet: {}, holoUniqueBySet: {}, unique: 0, holos: 0, totalScore: 0, points: 0, hands: {}, best,
  });
  const entryFor = (pack: ProfilePack, key = getPlayer().publicKeyHex.slice(0, 16)) =>
    ({ setId: SET.id, setVersion: SET.version, nonce: pack.nonce, key, cards: null, hand: pack.score.hand.name, score: pack.score.score, openedAt: 1000 + pack.nonce });
  const refOf = (pack: ProfilePack) => ({ setId: SET.id, setVersion: SET.version, nonce: pack.nonce, publicKeyHex: getPlayer().publicKeyHex });
  /** What the stats kept for `pack` when it opened, and the engine opening it again to the same cards. */
  const keep = (pack: ProfilePack) => {
    const cards = toCardsWithMeta(pack.cards, SET).map((c) => ({ ...c, isRevealed: true }));
    checkBestPack.mockImplementation(async (source: unknown) => ({ status: 'available', source, verified: { cards, score: scoreCards(cards) } }));
    return { stats: { highestPackRef: refOf(pack), highestPackCards: cards, highestPackFlexValue: pack.score.score }, cards };
  };
  /** Renders, then lets the (mocked) engine checks settle. */
  const renderSettled = async (props: Partial<Parameters<typeof ProfilePage>[0]>) => {
    render(props);
    await act(async () => {});
  };
  const section = (title: string) =>
    [...document.querySelectorAll('section.profile-highlight')].find((s) => s.querySelector('h2')?.textContent === title);
  const bestRow = () => section('Best pack')?.querySelector('.pull-row') ?? null;
  const bestBadges = () => [...(section('Best pack')?.querySelectorAll('.pull-row-sent') ?? [])].map((el) => el.textContent);

  it('leads the profile, after the player, with no best score or Best pulls repeating it', async () => {
    myStats.mockReturnValue(statsWith([five]));
    await renderSettled({ stats: keep(five).stats });
    const highlights = document.querySelector('.profile-highlights')!;
    const levelHeading = [...document.querySelectorAll('h2')].find((h) => h.textContent === 'Level and stats')!;
    expect(highlights.compareDocumentPosition(levelHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bestRow()?.querySelector('.profile-verified')?.textContent).toContain('Verified');
    expect(bestRow()?.querySelector('.pull-row-hand')?.firstChild?.textContent).toBe(five.score.hand.name);
    expect(section('Best card')?.textContent).toContain('None yet.');
    expect([...document.querySelectorAll('dt')].map((dt) => dt.textContent)).not.toContain('best score');
    expect([...document.querySelectorAll('h3')].map((h) => h.textContent)).not.toContain('Best pulls');
  });

  it("shares through the pack's own pull proof with the engine's cards, never the profile link", async () => {
    const onSharePack = vi.fn();
    const { stats, cards } = keep(five);
    myStats.mockReturnValue(statsWith([five]));
    await renderSettled({ stats, onSharePack });
    act(() => (bestRow() as HTMLElement).click());
    expect(onSharePack).toHaveBeenCalledWith(refOf(five), cards);
    expect(myProfileProof).not.toHaveBeenCalled();
  });

  it("stays verified when the profile link can't be made or the pack isn't in the history", async () => {
    myProfileInfo.mockReturnValue({ packs: 3, filled: 0, missing: 1, cache: 'ready' });
    getHistory.mockReturnValue([]);
    await renderSettled({ stats: keep(five).stats });
    expect(bestRow()?.querySelector('.profile-verified')).not.toBeNull();
    expect(bestBadges()).toEqual([]);
  });

  it("keeps a legacy best pack's own section and says why it can't be checked", async () => {
    const { cards } = keep(five);
    await renderSettled({ stats: { highestPackLegacy: true, highestPackCards: cards } });
    expect(checkBestPack).not.toHaveBeenCalled();
    expect(section('Best pack')?.textContent).toContain("from before verifiable pulls, so it can't be checked");
    expect(document.querySelector('.pulls-legacy')).not.toBeNull();
  });

  it('shows the same Not submitted, then Submitted, on a worthy best pack of your own', async () => {
    vi.doMock('../../game/nostrInbox', () => ({
      hallOfFameEvent: () => ({}),
      publishUntilAccepted: () => Promise.resolve({ accepted: 'wss://relay' }),
    }));
    getHistory.mockReturnValue([entryFor(five)]);
    await renderSettled({ stats: keep(five).stats });
    expect(five.score.hand.multiplier).toBeGreaterThanOrEqual(HALL_OF_FAME_MIN_MULTIPLIER);
    expect(bestBadges()).toEqual(['Not submitted']);

    await act(async () => {
      await submitToHallOfFame('proof', pullId({ setId: SET.id, setVersion: SET.version, publicKey: getPlayer().publicKey, nonce: NONCE }));
    });
    expect(bestBadges()).toEqual(['Submitted']);
    // The row still reads the hand first.
    expect(bestRow()?.querySelector('.pull-row-hand')?.firstChild?.textContent).toBe(five.score.hand.name);
  });

  it('draws the best pack the way the pack list draws the same pack: trophy, badge and set line', async () => {
    getHistory.mockReturnValue([entryFor(five)]);
    await renderSettled({ stats: keep(five).stats });
    const best = bestRow()!;
    const listed = document.querySelector('section[aria-labelledby="pulls-history-title"] .pull-row')!;
    // Same parts in the same order, whatever the thumbnails and the last words of the set line say; only the Verified mark is extra.
    const shape = (row: Element) =>
      [...row.querySelectorAll('.pull-row-hand > *, .pull-row-meta > .set-code, .pull-row-meta > .pull-row-setname')]
        .filter((el) => !el.classList.contains('profile-verified'))
        .map((el) => el.getAttribute('class'));
    expect(shape(best)).toEqual(shape(listed));
    expect(best.querySelector('.pull-row-hof')).not.toBeNull();
    expect(best.querySelector('.pull-row-meta')?.textContent).toContain(`ticket #${NONCE}`);
  });

  it("shows no badge on a best pack that can't qualify, or whose history entry is another player's", async () => {
    const weak = bestPack(SET.cards.slice(0, SET.packSize).map((c) => c.id), 8);
    expect(weak.score.hand.multiplier).toBeLessThan(HALL_OF_FAME_MIN_MULTIPLIER);
    getHistory.mockReturnValue([entryFor(weak)]);
    await renderSettled({ stats: keep(weak).stats });
    expect(bestBadges()).toEqual([]);
    expect(bestRow()?.querySelector('.pull-row-hof')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    getHistory.mockReturnValue([entryFor(five, 'b'.repeat(16))]);
    await renderSettled({ stats: keep(five).stats });
    expect(bestRow()?.querySelector('.pull-row-hof')).not.toBeNull();
    expect(bestBadges()).toEqual([]);
  });

  it("shows no badge when the profile is someone else's, which never passes one in", () => {
    getHistory.mockReturnValue([entryFor(five)]);
    act(() => root.render(<ProfileSummary stats={statsWith([five])} />));
    expect(document.querySelector('.profile-block .pull-row-hand')?.firstChild?.textContent).toBe(five.score.hand.name);
    expect(document.querySelector('.profile-block .pull-row-hof')).not.toBeNull();
    expect(document.querySelector('.pull-row-sent')).toBeNull();
  });

  it("explains where XP and the stats come from, with the engine's numbers (#804)", () => {
    act(() => root.render(<ProfileSummary stats={{ ...statsWith([five]), level: 3, xp: 400 }} />));
    const how = document.querySelector('details.profile-how')!;
    expect(how.querySelector('summary')?.textContent).toBe('What do these numbers mean?');
    const text = how.textContent ?? '';
    expect(text).toContain(`${XP_PER_PACK} XP for every pack opened`);
    expect(text).toContain(`${XP_PER_NEW_CARD} XP the first time you pull each different card`);
    for (const hand of ['TWO_PAIR', 'THREE_OF_A_KIND', 'FULL_HOUSE', 'FOUR_OF_A_KIND', 'FIVE_OF_A_KIND'] as const) {
      expect(text).toContain(`${POKER_HANDS[hand].name} +${XP_PER_HAND[hand].toLocaleString()}`);
    }
    // Most XP first; Two Pair and 3 of a Kind both pay +5, so the rarer 3 of a Kind goes first.
    const listed = [...text.matchAll(/(5 of a Kind|4 of a Kind|Full House|3 of a Kind|Two Pair) \+/g)].map((m) => m[1]);
    expect(listed).toEqual(['5 of a Kind', '4 of a Kind', 'Full House', '3 of a Kind', 'Two Pair']);
    expect(text).toContain('No Matches and Pair earn no bonus.');
    expect(text).toContain(`Level 4 needs ${xpForLevel(4).toLocaleString()} XP.`);
    for (const word of ['packs', 'cards', 'holo', 'best score', 'Collection score']) expect(text).toContain(word);
  });
});

describe('Best card place while the Best cards are weighed', () => {
  /** An older save's winners: listed by reference only, so the rebuild is what scores them. */
  const seedUnscored = () => {
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify({ secretKey: '22'.repeat(32), name: 'Me', nextNonce: 6, createdAt: 1 }));
    resetBestCards();
    const set = getSet('right-now', 2)!;
    localStorage.setItem(
      STORAGE_KEYS.BEST_CARDS,
      JSON.stringify({ [getPlayer().publicKeyHex]: { w: 1, b: [{ s: set.id, v: set.version, n: 0, i: 0, t: 1000 }, { s: set.id, v: set.version, n: 0, i: 1, t: 1000 }] } }),
    );
  };
  const expecting = () => expectingSeen.mock.calls[expectingSeen.mock.calls.length - 1]?.[0];
  const heldPlace = () => document.querySelector('section.profile-highlight .pull-row.profile-highlight-pending.best-card-row') !== null;
  /** A rebuild that ends, without scoring them, when the test says. */
  const gated = () => {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    rebuildBestCards.mockImplementation(async () => {
      await opened;
      return { cards: [], complete: true, unsaved: false, failed: 0 };
    });
    return release;
  };

  it('holds place while saved packs are still being read, so content arriving late does not shift layout', async () => {
    seedUnscored();
    myProfileInfo.mockReturnValue({ packs: 3, filled: 0, missing: 3, cache: 'loading' });
    myPackCacheState.mockReturnValue('loading');
    await act(async () => render());
    expect(expectingSeen).toHaveBeenCalled();
    expect(expecting()).toBe(true);
    expect(heldPlace()).toBe(true);
    expect(rebuildBestCards).not.toHaveBeenCalled();
  });

  it('expects a best card once the packs are read and winners are still being rebuilt, then stops when it ends', async () => {
    seedUnscored();
    const release = gated();
    await act(async () => render());
    expect(rebuildBestCards).toHaveBeenCalledTimes(1);
    expect(expecting()).toBe(true);
    expect(heldPlace()).toBe(true);

    await act(async () => release());
    expect(expecting()).toBe(false);
    expect(heldPlace()).toBe(false);
  });

  it('stops expecting once the section settles with nothing to weigh', async () => {
    await act(async () => render());
    expect(expecting()).toBe(false);
    expect(rebuildBestCards).not.toHaveBeenCalled();
    expect(document.querySelector('section.profile-highlight')).toBeNull();
  });

  it('stops expecting for a winner this build cannot rebuild (a newer build\'s set), and says it is not ranked yet', async () => {
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify({ secretKey: '22'.repeat(32), name: 'Me', nextNonce: 6, createdAt: 1 }));
    resetBestCards();
    const set = getSet('right-now', 2)!;
    localStorage.setItem(
      STORAGE_KEYS.BEST_CARDS,
      JSON.stringify({ [getPlayer().publicKeyHex]: { w: 1, b: [{ s: set.id, v: set.version + 50, n: 0, i: 0, t: 1000 }] } }),
    );
    await act(async () => render());
    expect(rebuildBestCards).not.toHaveBeenCalled();
    expect(expecting()).toBe(false);
    expect(heldPlace()).toBe(false);
    expect(document.body.textContent).toContain('Not ranked yet');
  });

  it('keeps the place as it is through Try again after the rebuild was lost: no pending row comes back', async () => {
    seedUnscored();
    const key = getPlayer().publicKeyHex;
    rebuildBestCards.mockImplementationOnce(async () => ({ ...actualBestCards.getBestCards(key, 6), failed: 1 }));
    await act(async () => render());
    expect(expecting()).toBe(false);
    expect(heldPlace()).toBe(false);
    expect(document.body.textContent).toContain('Not ranked yet');
    expectingSeen.mockClear(); // the first weigh did expect; only the retry is under test

    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    rebuildBestCards.mockImplementationOnce(async () => {
      await opened;
      return { ...actualBestCards.getBestCards(key, 6), failed: 1 };
    });
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!;
    await act(async () => retry.click());
    expect(rebuildBestCards).toHaveBeenCalledTimes(2);
    expect(expectingSeen.mock.calls.every(([value]) => value === false)).toBe(true);
    expect(heldPlace()).toBe(false);
    expect(document.body.textContent).toContain('Not ranked yet');

    await act(async () => release());
    expect(expectingSeen.mock.calls.every(([value]) => value === false)).toBe(true);
    expect(heldPlace()).toBe(false);
  });

  it('holds place while loading, continues holding while rebuilding, and releases once settled', async () => {
    seedUnscored();
    const release = gated();
    myProfileInfo.mockReturnValue({ packs: 3, filled: 0, missing: 3, cache: 'loading' });
    await act(async () => render());
    expect(expecting()).toBe(true);
    expect(heldPlace()).toBe(true);

    myProfileInfo.mockReturnValue({ packs: 3, filled: 0, missing: 0, cache: 'ready' });
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.HISTORY })));
    expect(expecting()).toBe(true);
    expect(heldPlace()).toBe(true);
    expect(rebuildBestCards).toHaveBeenCalledTimes(1);

    await act(async () => release());
    expect(expecting()).toBe(false);
    expect(heldPlace()).toBe(false);
  });

  it('expects nothing on an empty profile with no saved packs', async () => {
    myProfileInfo.mockReturnValue(null);
    await act(async () => render());
    expect(expecting()).toBe(false);
    expect(heldPlace()).toBe(false);
    expect(document.querySelector('section.profile-highlight')).toBeNull();
  });
});
