// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hallOfFameEvent, publishUntilAccepted, type PublishResult } from '../../game/nostrInbox';
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

    // ...and so does a stored empty id: there is no pull to call sent
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify(['']));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SUBMITTED_KEY }));
    });
    expect(latestState).toBe('idle');
  });

  describe('with two controls on one pull (the share sheet and the summary line)', () => {
    const controls: Record<string, { state: SubmitState; submit: () => Promise<boolean> }> = {};
    const Control = ({ name, id }: { name: string; id: string }) => {
      const [state, submit] = useHallOfFameSubmit('test-proof', id, 500);
      controls[name] = { state, submit };
      return null;
    };
    const states = () => [controls.a.state, controls.b.state];
    const ACCEPTED = { accepted: { relay: 'wss://relay.damus.io', ok: true, message: 'OK' }, all: Promise.resolve<PublishResult[]>([]) };
    const REFUSED = { accepted: null, all: Promise.resolve<PublishResult[]>([]) };
    const renderBoth = (idA = 'pull-two', idB = 'pull-two') =>
      act(() => {
        root!.render(
          <>
            <Control name="a" id={idA} />
            <Control name="b" id={idB} />
          </>,
        );
      });

    it('shows a failed send only on the control that made it', async () => {
      mockPublish.mockResolvedValueOnce(REFUSED);
      renderBoth();

      await act(async () => {
        await controls.a.submit();
      });

      expect(states()).toEqual(['failed', 'idle']);
    });

    it('shows sending and then sent on both controls, and sent replaces a failed one', async () => {
      mockPublish.mockResolvedValueOnce(REFUSED);
      renderBoth();
      await act(async () => {
        await controls.a.submit();
      });
      expect(states()).toEqual(['failed', 'idle']);

      let resolveRelay!: (value: typeof ACCEPTED) => void;
      mockPublish.mockReturnValueOnce(new Promise((resolve) => (resolveRelay = resolve)));
      let send!: Promise<boolean>;
      act(() => {
        send = controls.b.submit();
      });
      expect(states()).toEqual(['sending', 'sending']);

      await act(async () => {
        resolveRelay(ACCEPTED);
        await send;
      });
      expect(states()).toEqual(['sent', 'sent']);
    });

    it('sends a pull once when both controls press send together', async () => {
      let resolveRelay!: (value: typeof ACCEPTED) => void;
      mockPublish.mockReturnValueOnce(new Promise((resolve) => (resolveRelay = resolve)));
      renderBoth();

      let first!: Promise<boolean>;
      let second!: Promise<boolean>;
      act(() => {
        first = controls.a.submit();
        second = controls.b.submit();
      });
      await act(async () => {
        resolveRelay(ACCEPTED);
        await Promise.all([first, second]);
      });

      expect(mockPublish).toHaveBeenCalledTimes(1);
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(states()).toEqual(['sent', 'sent']);
    });

    it('keeps one control failed while the other pull is sent', async () => {
      mockPublish.mockResolvedValueOnce(REFUSED);
      renderBoth('pull-one', 'pull-other');
      await act(async () => {
        await controls.a.submit();
      });
      mockPublish.mockResolvedValueOnce(ACCEPTED);
      await act(async () => {
        await controls.b.submit();
      });
      expect(states()).toEqual(['failed', 'sent']);
    });
  });

  it('counts a send that throws as failed, and resolves false rather than throwing', async () => {
    mockPublish.mockRejectedValueOnce(new Error('relay list unreachable'));
    act(() => {
      root!.render(<Harness id="pull-throws" proof="test-proof" score={600} />);
    });

    let result: boolean | undefined;
    await act(async () => {
      result = await latestSubmit!();
    });

    expect(result).toBe(false);
    expect(latestState).toBe('failed');
  });

  it('shows sending, not failed, while a retry runs, and failed again if the retry does too', async () => {
    mockPublish.mockResolvedValueOnce({ accepted: null, all: Promise.resolve([]) });
    act(() => {
      root!.render(<Harness id="pull-retry-again" proof="test-proof" score={700} />);
    });
    await act(async () => {
      await latestSubmit!();
    });
    expect(latestState).toBe('failed');

    let resolveRelay!: (value: { accepted: null; all: Promise<PublishResult[]> }) => void;
    mockPublish.mockReturnValueOnce(new Promise((resolve) => (resolveRelay = resolve)));
    let retry!: Promise<boolean>;
    act(() => {
      retry = latestSubmit!();
    });
    expect(latestState).toBe('sending');

    await act(async () => {
      resolveRelay({ accepted: null, all: Promise.resolve([]) });
      await retry;
    });
    expect(latestState).toBe('failed');
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it('signs the proof, id and score it was given into the note it sends', async () => {
    mockPublish.mockResolvedValueOnce({ accepted: { relay: 'wss://relay.damus.io', ok: true, message: 'OK' }, all: Promise.resolve([]) });
    act(() => {
      root!.render(<Harness id="pull-args" proof="the-proof" score={812} />);
    });

    await act(async () => {
      await latestSubmit!();
    });

    expect(hallOfFameEvent).toHaveBeenCalledWith('the-proof', 'pull-args', expect.any(Number), 812);
  });

  it('follows the id it is given: a sent pull does not make the next one sent', () => {
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify(['pull-a']));
    act(() => {
      root!.render(<Harness id="pull-a" proof="test-proof" />);
    });
    expect(latestState).toBe('sent');

    act(() => {
      root!.render(<Harness id="pull-b" proof="test-proof" />);
    });
    expect(latestState).toBe('idle');
  });

  it('stops listening for storage changes when its last control unmounts', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const storageCalls = (spy: typeof add) => spy.mock.calls.filter(([type]) => (type as string) === 'storage');
    act(() => {
      root!.render(<Harness id="pull-unmount" proof="test-proof" />);
    });
    expect(storageCalls(add)).toHaveLength(1);

    act(() => root!.unmount());

    expect(storageCalls(remove)).toHaveLength(1);
    root = createRoot(container!);
  });
});
