// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wouldJoinHallOfFame, type PackScore } from '../../engine';
import { DEFAULT_SET_ID } from '../../content/sets';
import { loadHallOfFame, type HallOfFameEntry } from '../../game/hallOfFameList';
import { submitToHallOfFame } from '../../game/share';
import ShareSheet from './ShareSheet';

// The proof and the list are stand-ins: this checks where the Hall of Fame offer sits in the sheet.
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
vi.mock('../../game/hallOfFameList', () => ({ loadHallOfFame: vi.fn(async () => []) }));
vi.mock('../../game/share', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/share')>()),
  bragText: vi.fn(() => 'Look at this pull'),
  wasSubmitted: vi.fn(() => false),
  submitToHallOfFame: vi.fn(async () => true),
}));
vi.mock('../../game/bragImage', () => ({ renderPoster: vi.fn(async () => new Blob(['poster'], { type: 'image/png' })) }));

const score = { points: 100, hand: { name: 'Royal Rot' }, score: 1000 } as unknown as PackScore;
const target = { ref: { setId: DEFAULT_SET_ID, setVersion: 1, nonce: 3 }, cards: [], score };
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:poster'; }
    static revokeObjectURL() {}
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** True when each element (or selector's element) comes after the one before it in the document. */
const inOrder = (items: (string | Element | undefined)[]) => {
  const els = items.map((item) => (typeof item === 'string' ? document.querySelector(item) : item));
  expect(els.every(Boolean)).toBe(true);
  return els.every((el, i) => i === 0 || !!(els[i - 1]!.compareDocumentPosition(el!) & Node.DOCUMENT_POSITION_FOLLOWING));
};

describe('Hall of Fame in the pack share sheet', () => {
  it('offers the submit with the share buttons, ahead of the poster and the cards', async () => {
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    expect(inOrder(['.share-actions-main', '.share-hof', '.share-preview', '.share-pack-cards'])).toBe(true);
  });

  it('puts the already-listed note in the same place', async () => {
    vi.mocked(loadHallOfFame).mockResolvedValueOnce([{ id: 'pull-1' } as HallOfFameEntry]);
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    expect(document.querySelector('.share-hof')).toBeNull();
    const listed = [...document.querySelectorAll('.share-note')].find((el) => el.textContent?.includes('in the Hall of Fame'));
    expect(inOrder(['.share-actions-main', listed, '.share-preview', '.share-pack-cards'])).toBe(true);
  });

  const clickSubmit = async () => {
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    const button = [...document.querySelectorAll<HTMLButtonElement>('.share-hof button')].find((b) => b.textContent === 'Submit')!;
    await act(async () => button.click());
    return button;
  };

  it('shows the pull as submitted once a relay takes it, without a relay count', async () => {
    const button = await clickSubmit();
    expect(submitToHallOfFame).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitToHallOfFame).mock.calls[0][2]).toBe(1000); // the score hint the inbox can skip on
    expect(button.textContent).toBe('Submitted');
    expect(button.disabled).toBe(true);
    const status = document.querySelector('.share-hof [role="status"]')!.textContent!;
    expect(status).toContain('It shows in the Hall of Fame now');
    expect(status).not.toMatch(/relays?\b/);
  });

  it('offers a retry when no relay takes it', async () => {
    vi.mocked(submitToHallOfFame).mockResolvedValueOnce(false);
    const button = await clickSubmit();
    expect(button.textContent).toBe('Submit');
    expect(button.disabled).toBe(false);
    expect(document.querySelector('.share-hof [role="status"]')!.textContent).toContain("Couldn't reach any relay");
  });

  it('counts today’s top (UTC) when deciding whether to offer the submit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T23:30:00-05:00'));
    try {
      await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    } finally {
      vi.useRealTimers();
    }
    expect(vi.mocked(wouldJoinHallOfFame)).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pull-1' }), [], '2026-10-17');
  });
});
