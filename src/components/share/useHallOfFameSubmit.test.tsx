// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishUntilAccepted, type PublishResult } from '../../game/nostrInbox';
import { resetSubmissionsForTest, SUBMITTED_KEY } from '../../game/share';
import { useHallOfFameSubmit, type SubmitState } from './useHallOfFameSubmit';

vi.mock('../../game/nostrInbox', () => ({
  hallOfFameEvent: vi.fn((proof: string, id: string, date: number, score?: number) => ({ id, proof, date, score })),
  publishUntilAccepted: vi.fn(),
}));

const mockPublish = vi.mocked(publishUntilAccepted);

describe('useHallOfFameSubmit', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let latestState: SubmitState | undefined;
  let latestSubmit: (() => Promise<boolean>) | undefined;

  const Harness = ({ id, proof, score }: { id: string; proof: string; score?: number }) => {
    const [state, submit] = useHallOfFameSubmit(proof, id, score);
    latestState = state;
    latestSubmit = submit;
    return <span data-testid="status">{state}</span>;
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
    resetSubmissionsForTest();
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestState = undefined;
    latestSubmit = undefined;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    resetSubmissionsForTest();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts idle and updates to sent when another tab records submission', () => {
    act(() => {
      root!.render(<Harness id="pull-cross-tab" proof="test-proof" score={100} />);
    });
    expect(latestState).toBe('idle');
    expect(container?.textContent).toBe('idle');

    // Simulate cross-tab write
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify(['pull-cross-tab']));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SUBMITTED_KEY }));
    });

    expect(latestState).toBe('sent');
    expect(container?.textContent).toBe('sent');

    // Simulate cross-tab storage clear
    localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });

    expect(latestState).toBe('idle');
    expect(container?.textContent).toBe('idle');
  });

  it('handles submission lifecycle: idle -> sending -> sent', async () => {
    let resolveRelay!: (val: { accepted: PublishResult | null; all: Promise<PublishResult[]> }) => void;
    mockPublish.mockReturnValue(
      new Promise((resolve) => {
        resolveRelay = resolve;
      }),
    );

    act(() => {
      root!.render(<Harness id="pull-send" proof="test-proof" score={200} />);
    });
    expect(latestState).toBe('idle');

    let sendPromise!: Promise<boolean>;
    act(() => {
      sendPromise = latestSubmit!();
    });

    expect(latestState).toBe('sending');

    await act(async () => {
      resolveRelay({
        accepted: { relay: 'wss://relay.damus.io', ok: true, message: 'OK' },
        all: Promise.resolve<PublishResult[]>([]),
      });
      await sendPromise;
    });

    expect(latestState).toBe('sent');
    expect(container?.textContent).toBe('sent');
  });

  it('transitions to failed when relay refuses and recovers on retry', async () => {
    mockPublish.mockResolvedValueOnce({ accepted: null, all: Promise.resolve([]) });

    act(() => {
      root!.render(<Harness id="pull-retry" proof="test-proof" score={300} />);
    });

    let success = true;
    await act(async () => {
      success = await latestSubmit!();
    });

    expect(success).toBe(false);
    expect(latestState).toBe('failed');
    expect(container?.textContent).toBe('failed');

    // Retry succeeds
    mockPublish.mockResolvedValueOnce({
      accepted: { relay: 'wss://relay.damus.io', ok: true, message: 'OK' },
      all: Promise.resolve([]),
    });

    await act(async () => {
      success = await latestSubmit!();
    });

    expect(success).toBe(true);
    expect(latestState).toBe('sent');
    expect(container?.textContent).toBe('sent');
  });

  it('stays idle when id is empty', () => {
    act(() => {
      root!.render(<Harness id="" proof="test-proof" score={400} />);
    });
    expect(latestState).toBe('idle');

    // Even if another pull is recorded in storage, empty id stays idle
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify(['pull-other']));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SUBMITTED_KEY }));
    });
    expect(latestState).toBe('idle');
  });
});
