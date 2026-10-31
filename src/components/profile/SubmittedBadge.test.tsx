// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pullId } from '../../engine';
import { type HistoryEntry } from '../../game/history';
import { getPlayer } from '../../game/player';
import { resetSubmissionsForTest, SUBMITTED_KEY } from '../../game/share';
import SubmittedBadge from './SubmittedBadge';

describe('SubmittedBadge', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  const playerKey = getPlayer().publicKeyHex.slice(0, 16);
  const qualifyingEntry = (nonce = 1): HistoryEntry => ({
    setId: 'genesis',
    setVersion: 1,
    nonce,
    openedAt: 1000,
    cards: [],
    hand: 'Five of a Kind',
    score: 1_000_000,
    key: playerKey,
  });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
    resetSubmissionsForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    resetSubmissionsForTest();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('updates live from Not submitted to Submitted when another tab writes to storage, and back on clear', () => {
    const entry = qualifyingEntry(42);
    const id = pullId({
      setId: entry.setId,
      setVersion: entry.setVersion,
      publicKey: getPlayer().publicKey,
      nonce: entry.nonce,
    });

    act(() => {
      root!.render(<SubmittedBadge entry={entry} />);
    });

    const badge = () => container?.querySelector('.pull-row-sent');
    expect(badge()?.textContent).toBe('Not submitted');
    expect(badge()?.classList.contains('pull-row-sent--done')).toBe(false);

    // Another tab records the submission in storage
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify([id]));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SUBMITTED_KEY }));
    });

    expect(badge()?.textContent).toBe('Submitted');
    expect(badge()?.classList.contains('pull-row-sent--done')).toBe(true);
    expect(badge()?.getAttribute('title')).toBe('Sent from this device');
    expect(badge()?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    // Another tab clears storage
    localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });

    expect(badge()?.textContent).toBe('Not submitted');
    expect(badge()?.classList.contains('pull-row-sent--done')).toBe(false);
  });

  it('renders nothing for non-qualifying packs or packs opened by another player', () => {
    const nonQualifying: HistoryEntry = {
      ...qualifyingEntry(1),
      hand: 'High Card',
      score: 10,
    };
    act(() => {
      root!.render(<SubmittedBadge entry={nonQualifying} />);
    });
    expect(container?.innerHTML).toBe('');

    const otherPlayerEntry: HistoryEntry = {
      ...qualifyingEntry(2),
      key: 'f'.repeat(16),
    };
    act(() => {
      root!.render(<SubmittedBadge entry={otherPlayerEntry} />);
    });
    expect(container?.innerHTML).toBe('');
  });

  it('unmounts cleanly without leaking window storage listeners', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const entry = qualifyingEntry(99);

    act(() => {
      root!.render(<SubmittedBadge entry={entry} />);
    });

    act(() => {
      root!.unmount();
    });
    root = null;

    expect(removeSpy).toHaveBeenCalledWith('storage', expect.any(Function));
  });
});
