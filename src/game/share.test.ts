// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scorePack, type Finish, type Rarity } from '../engine';
import {
  SUBMITTED_KEY,
  bragText,
  onSubmissionChange,
  resetSubmissionsForTest,
  submissionStatus,
  submitToHallOfFame,
  wasSubmitted,
} from './share';
import { publishUntilAccepted, type PublishResult } from './nostrInbox';

const staging = vi.hoisted(() => ({ on: false }));
vi.mock('./staging', () => ({ isStaging: () => staging.on }));

vi.mock('./nostrInbox', () => ({
  hallOfFameEvent: vi.fn((proof: string, id: string, date: number, score?: number) => ({ id, proof, date, score })),
  publishUntilAccepted: vi.fn(),
}));

const mockPublish = vi.mocked(publishUntilAccepted);

const card = (rarity: Rarity, isHolo = false, finish: Finish | null = null, misprint = false) => ({ cardId: `${rarity}-${isHolo}`, rarity, isHolo, finish, misprint });

describe('bragText', () => {
  it('marks every rarity with a letter as well as a colour, and holo cards with a sparkle', () => {
    const cards = [card('COMMON'), card('UNCOMMON'), card('RARE', true), card('EPIC'), card('LEGENDARY'), card('BRAINROT', true)];
    const lines = bragText(cards, scorePack(cards), 'Peak Brain Rot', 'https://example.test/p').split('\n');
    expect(lines[0]).toBe('🧠 Brainrot TCG · Peak Brain Rot');
    expect(lines[1]).toBe('⬜C 🟩U 🟦R✨ 🟪E 🟧L 🟥B✨');
    expect(lines[2]).toBe('✨ Holo');
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('Verify it yourself: https://example.test/p');
  });

  it('marks each card with its modifiers and names the pack\'s, rarest first', () => {
    const cards = [card('COMMON', true), card('RARE', false, 'GOLD'), card('EPIC', true, 'SILVER', true), card('LEGENDARY', false, 'DIAMOND'), card('COMMON')];
    const lines = bragText(cards, scorePack(cards), 'Set', 'u').split('\n');
    expect(lines[1]).toBe('⬜C✨ 🟦R🥇 🟪E🖨️✨🥈 🟧L💎 ⬜C');
    expect(lines[2]).toBe('💎 Diamond · 🖨️ Misprint · 🥇 Gold · ✨ Holo · 🥈 Silver');
    expect(lines[lines.length - 1]).toBe('Verify it yourself: u');
    const platinum = [card('RARE', false, 'PLATINUM'), card('RARE', false, null, true)];
    expect(bragText(platinum, scorePack(platinum), 'Set', 'u').split('\n')[2]).toBe('💿 Platinum · 🖨️ Misprint');
  });

  it('leaves the modifier line out of a pack without any', () => {
    const cards = [card('COMMON'), card('RARE', false, null, false), card('EPIC')];
    const lines = bragText(cards, scorePack(cards), 'Set', 'u').split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('⬜C 🟦R 🟪E');
    expect(lines[2]).toMatch(/Brainrot Score$/);
  });

  it('keeps the rarity row readable with the colour emoji stripped', () => {
    const cards = [card('LEGENDARY', false, 'GOLD'), card('EPIC', true, 'PLATINUM', true), card('COMMON')];
    const row = bragText(cards, scorePack(cards), 'Set', 'u').split('\n')[1];
    expect(row.replace(/\p{Extended_Pictographic}|️/gu, '')).toBe('L E C');
  });
});

describe('submission registry and cross-tab storage sync', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSubmissionsForTest();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetSubmissionsForTest();
    localStorage.clear();
  });

  it('sends nothing to the relays from a staging copy', async () => {
    staging.on = true;
    try {
      expect(await submitToHallOfFame('proof-staging', 'pull-staging', 1000)).toBe(false);
    } finally {
      staging.on = false;
    }
    expect(mockPublish).not.toHaveBeenCalled();
    expect(submissionStatus('pull-staging')).toBe('idle');
    expect(wasSubmitted('pull-staging')).toBe(false);
  });

  it('reports idle initially for unknown pulls', () => {
    expect(wasSubmitted('pull-unknown')).toBe(false);
    expect(submissionStatus('pull-unknown')).toBe('idle');
  });

  it('reads sent pulls from localStorage under SUBMITTED_KEY', () => {
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify(['pull-1', 'pull-2']));
    expect(wasSubmitted('pull-1')).toBe(true);
    expect(wasSubmitted('pull-2')).toBe(true);
    expect(wasSubmitted('pull-3')).toBe(false);
    expect(submissionStatus('pull-1')).toBe('sent');
    expect(submissionStatus('pull-3')).toBe('idle');
  });

  it('handles corrupted JSON in localStorage without throwing', () => {
    localStorage.setItem(SUBMITTED_KEY, 'invalid-json{[');
    expect(wasSubmitted('pull-1')).toBe(false);
    expect(submissionStatus('pull-1')).toBe('idle');
  });

  it('notifies subscribers on cross-tab storage writes and clears', () => {
    const listener = vi.fn();
    const unsub = onSubmissionChange(listener);

    // Another tab writes a newly submitted pull ID
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify(['pull-tab-b']));
    window.dispatchEvent(new StorageEvent('storage', { key: SUBMITTED_KEY }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(wasSubmitted('pull-tab-b')).toBe(true);
    expect(submissionStatus('pull-tab-b')).toBe('sent');

    // Another tab clears storage
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));

    expect(listener).toHaveBeenCalledTimes(2);
    expect(wasSubmitted('pull-tab-b')).toBe(false);
    expect(submissionStatus('pull-tab-b')).toBe('idle');

    // Storage event for an unrelated key is ignored
    window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-player-v1' }));
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('ref-counts window storage listener attachment and detaches on unsubscribe', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const listenerA = vi.fn();
    const listenerB = vi.fn();

    // First subscriber attaches the window storage listener
    const unsubA = onSubmissionChange(listenerA);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith('storage', expect.any(Function));

    // Second subscriber reuses the existing window listener
    const unsubB = onSubmissionChange(listenerB);
    expect(addSpy).toHaveBeenCalledTimes(1);

    // First unsubscription does not remove the window listener
    unsubA();
    expect(removeSpy).not.toHaveBeenCalled();

    // Calling the same unsubscription again is idempotent
    unsubA();
    expect(removeSpy).not.toHaveBeenCalled();

    // Last unsubscription detaches the window listener
    unsubB();
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('storage', expect.any(Function));

    // Subsequent storage events are no longer delivered
    window.dispatchEvent(new StorageEvent('storage', { key: SUBMITTED_KEY }));
    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent submissions for the same ID to a single promise and notifies subscribers', async () => {
    let resolvePublish!: (value: { accepted: PublishResult | null; all: Promise<PublishResult[]> }) => void;
    mockPublish.mockReturnValue(
      new Promise((resolve) => {
        resolvePublish = resolve;
      }),
    );

    const listener = vi.fn();
    const unsub = onSubmissionChange(listener);

    expect(submissionStatus('pull-dedup')).toBe('idle');

    const p1 = submitToHallOfFame('proof-data', 'pull-dedup', 5000);
    expect(submissionStatus('pull-dedup')).toBe('sending');
    expect(listener).toHaveBeenCalledTimes(1);

    // Second call for the same ID while sending joins the identical promise
    const p2 = submitToHallOfFame('proof-data', 'pull-dedup', 5000);
    expect(p2).toBe(p1);

    await vi.waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(1));

    resolvePublish({
      accepted: { relay: 'wss://relay.damus.io', ok: true, message: 'accepted' },
      all: Promise.resolve<PublishResult[]>([]),
    });

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1).toBe(true);
    expect(res2).toBe(true);
    expect(submissionStatus('pull-dedup')).toBe('sent');
    expect(wasSubmitted('pull-dedup')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);

    const stored = JSON.parse(localStorage.getItem(SUBMITTED_KEY) ?? '[]');
    expect(stored).toContain('pull-dedup');

    unsub();
  });

  it('reverts status to idle and allows retry when relays refuse or fail', async () => {
    mockPublish.mockResolvedValueOnce({ accepted: null, all: Promise.resolve([]) });

    const listener = vi.fn();
    const unsub = onSubmissionChange(listener);

    const result1 = await submitToHallOfFame('proof-fail', 'pull-fail', 1000);
    expect(result1).toBe(false);
    expect(submissionStatus('pull-fail')).toBe('idle');
    expect(wasSubmitted('pull-fail')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2); // idle -> sending -> idle

    // Retry succeeds
    mockPublish.mockResolvedValueOnce({
      accepted: { relay: 'wss://relay.damus.io', ok: true, message: 'accepted' },
      all: Promise.resolve([]),
    });

    const result2 = await submitToHallOfFame('proof-fail', 'pull-fail', 1000);
    expect(result2).toBe(true);
    expect(submissionStatus('pull-fail')).toBe('sent');
    expect(wasSubmitted('pull-fail')).toBe(true);

    unsub();
  });

  it('preserves sentHere fallback when storage quota is exceeded or setItem throws', async () => {
    mockPublish.mockResolvedValueOnce({
      accepted: { relay: 'wss://relay.damus.io', ok: true, message: 'accepted' },
      all: Promise.resolve([]),
    });

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    const result = await submitToHallOfFame('proof-quota', 'pull-quota', 2000);
    expect(result).toBe(true);

    setItemSpy.mockRestore();
    expect(localStorage.getItem(SUBMITTED_KEY)).toBeNull();

    // sentHere holds the sent status on this tab
    expect(wasSubmitted('pull-quota')).toBe(true);
    expect(submissionStatus('pull-quota')).toBe('sent');

    // Even if another tab clears storage, sentHere keeps this tab's send marked sent
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(wasSubmitted('pull-quota')).toBe(true);
    expect(submissionStatus('pull-quota')).toBe('sent');
  });

  it('caps submitted IDs to the last 200 entries without duplicates', async () => {
    const existing = Array.from({ length: 205 }, (_, i) => `old-pull-${i}`);
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify(existing));

    mockPublish.mockResolvedValueOnce({
      accepted: { relay: 'wss://relay.damus.io', ok: true, message: 'accepted' },
      all: Promise.resolve([]),
    });

    await submitToHallOfFame('proof-new', 'new-pull', 3000);

    const stored = JSON.parse(localStorage.getItem(SUBMITTED_KEY) ?? '[]') as string[];
    expect(stored).toHaveLength(200);
    expect(stored[stored.length - 1]).toBe('new-pull');
    expect(stored).not.toContain('old-pull-0');
    expect(stored).toContain('old-pull-6');
  });
});
