// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qualifiesForHallOfFame, wouldJoinHallOfFame, type PackScore } from '../../engine';
import { DEFAULT_SET_ID } from '../../content/sets';
import { loadHallOfFame, type HallOfFameEntry } from '../../game/hallOfFameList';
import { submitToHallOfFame, wasSubmitted } from '../../game/share';
import SummaryHallOfFame from './SummaryHallOfFame';

// The proof and the list are stand-ins: this checks each state of the line, not the join rules.
vi.mock('../../game/pulls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/pulls')>()),
  canShare: vi.fn(() => true),
  proofFor: vi.fn(() => 'proof'),
}));
vi.mock('../../engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../engine')>()),
  decodeProof: vi.fn(() => ({})),
  pullId: vi.fn(() => 'pull-1'),
  qualifiesForHallOfFame: vi.fn(() => true),
  wouldJoinHallOfFame: vi.fn(() => true),
}));
vi.mock('../../game/hallOfFameList', () => ({ loadHallOfFame: vi.fn(async () => []) }));
vi.mock('../../game/share', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/share')>()),
  wasSubmitted: vi.fn(() => false),
  submitToHallOfFame: vi.fn(async () => true),
}));

const score = { points: 100, hand: { name: 'Royal Rot', multiplier: 50 }, score: 5000 } as unknown as PackScore;
const pack = { setId: DEFAULT_SET_ID, setVersion: 1, nonce: 3 };
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () => root.render(<SummaryHallOfFame pack={pack} score={score} />));
  return container.querySelector('.summary-hof');
};
/** The line as read, one space between its parts (the gaps are CSS). */
const line = () => [...(container.querySelector('.summary-hof')?.children ?? [])].map((el) => el.textContent).join(' ');
const button = () => container.querySelector<HTMLButtonElement>('.summary-hof button');

describe('the Hall of Fame line on the pack summary', () => {
  it('shows nothing for a pull that does not qualify', async () => {
    vi.mocked(qualifiesForHallOfFame).mockReturnValueOnce(false);
    expect(await render()).toBeNull();
    expect(loadHallOfFame).not.toHaveBeenCalled();
  });

  it("shows nothing for a pull that wouldn't make today's Rankings", async () => {
    vi.mocked(wouldJoinHallOfFame).mockReturnValue(false);
    try {
      expect(await render()).toBeNull();
    } finally {
      vi.mocked(wouldJoinHallOfFame).mockReturnValue(true);
    }
  });

  it('shows nothing for a pull already listed', async () => {
    vi.mocked(loadHallOfFame).mockResolvedValueOnce([{ id: 'pull-1' } as HallOfFameEntry]);
    expect(await render()).toBeNull();
  });

  it("offers one-tap Submit for a pull that makes today's Rankings", async () => {
    await render();
    expect(line()).toBe("🏆 Makes today's Rankings · Submit to the Hall of Fame");
    expect(button()?.textContent).toBe('Submit to the Hall of Fame');
  });

  it('says it is submitting while the first relay has not answered', async () => {
    let accept: (ok: boolean) => void = () => {};
    vi.mocked(submitToHallOfFame).mockReturnValueOnce(new Promise((resolve) => (accept = resolve)));
    await render();
    await act(async () => button()!.click());
    expect(line()).toBe('🏆 Submitting…');
    expect(button()).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('.summary-hof'));
    expect(submitToHallOfFame).toHaveBeenCalledWith('proof', 'pull-1', 5000);
    await act(async () => accept(true));
  });

  it("reads Submitted with today's place once a relay accepts", async () => {
    await render();
    await act(async () => button()!.click());
    expect(line()).toBe('🏆 Submitted · #1 today');
  });

  it("reads just Submitted when the list couldn't load", async () => {
    vi.mocked(loadHallOfFame).mockResolvedValueOnce(null);
    await render();
    await act(async () => button()!.click());
    expect(line()).toBe('🏆 Submitted');
  });

  it('offers Retry when every relay refuses, and a retry can still send it', async () => {
    vi.mocked(submitToHallOfFame).mockResolvedValueOnce(false);
    await render();
    await act(async () => button()!.click());
    expect(line()).toBe("🏆 Couldn't submit · Retry");
    vi.mocked(submitToHallOfFame).mockRejectedValueOnce(new Error('offline'));
    await act(async () => button()!.click());
    expect(line()).toBe("🏆 Couldn't submit · Retry");
    await act(async () => button()!.click());
    expect(line()).toBe('🏆 Submitted · #1 today');
  });

  it('reads Submitted for a pull this device already sent', async () => {
    vi.mocked(wasSubmitted).mockReturnValueOnce(true);
    await render();
    expect(line()).toBe('🏆 Submitted');
    expect(button()).toBeNull();
  });
});
