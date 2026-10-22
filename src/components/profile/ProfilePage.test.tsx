// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage';
import ProfileSummary from './ProfileSummary';
import { DEFAULT_SETTINGS } from '../../utils/settings';
import { ACHIEVEMENTS } from '../../data/achievements';
import { getSet } from '../../content/sets';
import { HALL_OF_FAME_MIN_MULTIPLIER, pullId, scorePulled, type ProfilePack, type ProfileStats } from '../../engine';
import { toPulled } from '../../game/cardCode';
import { getPlayer } from '../../game/player';
import { submitToHallOfFame } from '../../game/share';

const { myProfileInfo, myProfileProof, myStats, myPackCacheState, hydrateMyPacks } = vi.hoisted(() => ({
  myProfileInfo: vi.fn(), myProfileProof: vi.fn(), myStats: vi.fn(), myPackCacheState: vi.fn(), hydrateMyPacks: vi.fn(),
}));
vi.mock('../../game/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/profiles')>()),
  myProfileInfo,
  myProfileProof,
  myStats,
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

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver; the profile card's Sheet only uses it to track overflow.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  myProfileInfo.mockReset().mockReturnValue({ packs: 3, filled: 0, missing: 0, cache: 'ready' });
  myProfileProof.mockReset();
  myStats.mockReset().mockImplementation(actual.myStats);
  myPackCacheState.mockReset().mockReturnValue('ready');
  hydrateMyPacks.mockReset().mockResolvedValue('ready');
  getHistory.mockReset().mockImplementation(actualHistory.getHistory);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
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
      expect(hands()).toHaveLength(5);
      act(() => more()!.click());
      expect(hands()).toHaveLength(35);
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
});

describe('Hall of Fame submitted badge on Best pulls', () => {
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
  /** The badges inside the Best pulls list (the pack list further down carries its own). */
  const bestBadges = () => {
    const section = [...document.querySelectorAll('section.profile-block')].find((s) => s.querySelector('h3')?.textContent === 'Best pulls');
    return [...(section?.querySelectorAll('.pull-row-sent') ?? [])].map((el) => el.textContent);
  };

  it('shows the same Not submitted, then Submitted, on a worthy best pull of your own', async () => {
    vi.doMock('../../game/nostrInbox', () => ({
      hallOfFameEvent: () => ({}),
      publishUntilAccepted: () => Promise.resolve({ accepted: 'wss://relay' }),
    }));
    myStats.mockReturnValue(statsWith([five]));
    getHistory.mockReturnValue([entryFor(five)]);
    render();
    expect(five.score.hand.multiplier).toBeGreaterThanOrEqual(HALL_OF_FAME_MIN_MULTIPLIER);
    expect(bestBadges()).toEqual(['Not submitted']);

    await act(async () => {
      await submitToHallOfFame('proof', pullId({ setId: SET.id, setVersion: SET.version, publicKey: getPlayer().publicKey, nonce: NONCE }));
    });
    expect(bestBadges()).toEqual(['Submitted']);
    // The row still reads the hand first.
    expect(document.querySelector('section.profile-block .pull-row-hand')?.firstChild?.textContent).toBe(five.score.hand.name);
  });

  it('draws a best pull the way the pack list draws the same pack: trophy, badge and set line', () => {
    myStats.mockReturnValue(statsWith([five]));
    getHistory.mockReturnValue([entryFor(five)]);
    render();
    const best = document.querySelector('section.profile-block .pull-row')!;
    const listed = document.querySelector('section[aria-labelledby="pulls-history-title"] .pull-row')!;
    // Same parts in the same order, whatever the thumbnails and the last words of the set line say.
    const shape = (row: Element) => [...row.querySelectorAll('.pull-row-hand > *, .pull-row-meta > .set-code, .pull-row-meta > .pull-row-setname')].map((el) => el.getAttribute('class'));
    expect(shape(best)).toEqual(shape(listed));
    expect(best.querySelector('.pull-row-hof')).not.toBeNull();
    expect(best.querySelector('.pull-row-hand .sr-only')?.textContent).toBe(', qualifies for Rankings');
    expect(best.querySelector('.pull-row-meta')?.textContent).toContain(`ticket #${NONCE}`);
  });

  it("shows nothing on a best pull that can't qualify, or that another player on this device opened", () => {
    const weak = bestPack(SET.cards.slice(0, SET.packSize).map((c) => c.id), 8);
    expect(weak.score.hand.multiplier).toBeLessThan(HALL_OF_FAME_MIN_MULTIPLIER);
    myStats.mockReturnValue(statsWith([five, weak]));
    getHistory.mockReturnValue([entryFor(five, 'b'.repeat(16)), entryFor(weak)]);
    render();
    expect(bestBadges()).toEqual([]);
    // The trophy follows the score alone: the weak pack gets none, the qualifying one has it whoever opened it.
    const hof = [...document.querySelectorAll('section.profile-block .pull-row')].map((row) => row.querySelector('.pull-row-hof') !== null);
    expect(hof).toEqual([true, false]);
  });

  it("shows no badge when the profile is someone else's, which never passes one in", () => {
    getHistory.mockReturnValue([entryFor(five)]);
    act(() => root.render(<ProfileSummary stats={statsWith([five])} />));
    expect(document.querySelector('.profile-block .pull-row-hand')?.firstChild?.textContent).toBe(five.score.hand.name);
    expect(document.querySelector('.profile-block .pull-row-hof')).not.toBeNull();
    expect(document.querySelector('.pull-row-sent')).toBeNull();
  });
});
