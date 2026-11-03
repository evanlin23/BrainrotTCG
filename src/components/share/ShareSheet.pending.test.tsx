// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SET_ID } from '../../content/sets';
import type { PackScore } from '../../engine';

// The relay read is the one real boundary here: hallOfFameList is the real module, so its cache is
// what decides how many reads reopening the sheet costs (#1317).
const fetchEvents = vi.hoisted(() => vi.fn());
vi.mock('../../game/nostrInbox', () => ({
  fetchEvents,
  proofFromEvent: vi.fn(() => null),
  HOF_KIND: 30_078,
  HOF_TAG: 'hof',
  hallOfFameEvent: vi.fn(() => ({})),
  publishUntilAccepted: vi.fn(async () => ({ accepted: {}, all: Promise.resolve([]) })),
}));
vi.mock('../../game/pulls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/pulls')>()),
  canShare: vi.fn(() => true),
  proofFor: vi.fn(() => 'proof'),
  pullUrl: vi.fn(() => 'https://example.invalid/#/pull/proof'),
}));
vi.mock('../../engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../engine')>()),
  decodeProof: vi.fn(() => ({})),
  pullId: vi.fn(() => 'pull-1'),
  qualifiesForHallOfFame: vi.fn(() => true),
  wouldJoinHallOfFame: vi.fn(() => true),
}));
vi.mock('../../game/bragImage', () => ({ renderPoster: vi.fn(async () => new Blob(['poster'], { type: 'image/png' })) }));

const score = { points: 100, hand: { name: 'Royal Rot' }, score: 1000 } as unknown as PackScore;
const target = { ref: { setId: DEFAULT_SET_ID, setVersion: 1, nonce: 3 }, cards: [], score };
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:poster'; }
    static revokeObjectURL() {}
  });
  // The published list and the list of rejected pulls: both empty and well-formed.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response));
  fetchEvents.mockReset();
  fetchEvents.mockResolvedValue({ events: [], perRelay: [{ relay: 'wss://a', count: 0 }] });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the pack share sheet reading pending pulls from the relays', () => {
  it('reads them once however many times it opens within the cache window (#1317)', async () => {
    const { default: Sheet } = await import('./ShareSheet');
    for (let open = 0; open < 3; open++) {
      await act(async () => root.render(<Sheet target={target} onClose={() => {}} />));
      await act(async () => root.render(null));
    }
    expect(fetchEvents).toHaveBeenCalledTimes(1);
  });

  it('stops the read when the sheet closes, and reads again on the next open', async () => {
    const { default: Sheet } = await import('./ShareSheet');
    let signal: AbortSignal | undefined;
    fetchEvents.mockImplementationOnce(async (...args: unknown[]) => {
      signal = args[5] as AbortSignal;
      await act(async () => root.render(null));
      return { events: [], perRelay: [{ relay: 'wss://a', count: 0 }] };
    });
    await act(async () => root.render(<Sheet target={target} onClose={() => {}} />));
    expect(signal?.aborted).toBe(true);
    await act(async () => root.render(<Sheet target={target} onClose={() => {}} />));
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });
});
