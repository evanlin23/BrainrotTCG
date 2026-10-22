// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkPull, previewFor, pullUrl, type CheckedPull } from '../../game/pulls';
import { OUT_OF_MEMORY_ADVICE, TicketMemoryError } from '../../game/ticketPool';
import PullViewerPage from './PullViewerPage';

// The pull is a stand-in: this checks only how the player's name is shown.
vi.mock('../../game/pulls', () => ({
  checkPull: vi.fn(),
  previewFor: vi.fn(),
  pullUrl: vi.fn((proof: string, preview?: string) => preview ? `https://example.invalid/#/pull/${proof}?p=${preview}` : `https://example.invalid/#/pull/${proof}`),
}));
vi.mock('../ui/PackCardViewer', () => ({ default: () => null }));

const pull = (name: string) =>
  ({
    set: { id: 'og', name: 'Original', version: 1 },
    proof: { setId: 'og', setVersion: 1, publicKey: 'key', nonce: 3, name, signature: 'sig' },
    score: { hand: { name: 'Full House' } },
    fingerprint: 'abcd',
    cardsWithMeta: [],
  }) as unknown as CheckedPull;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText: vi.fn(async () => undefined) } }));
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const subtitle = async (name: string) => {
  vi.mocked(checkPull).mockResolvedValueOnce(pull(name));
  await act(async () => root.render(<PullViewerPage proof="proof" onClose={() => {}} />));
  return document.body.textContent ?? '';
};

describe('PullViewerPage', () => {
  it("shows the player's name beside the key fingerprint", async () => {
    expect(await subtitle('Pack Ripper')).toContain('Pack Ripper #abcd');
  });

  it("shows a valid pull whose display name isn't allowed as Player, never the name itself", async () => {
    const text = await subtitle('xXfuckXx');
    expect(text).toContain('Verified on this device');
    expect(text).toContain('Player #abcd');
    expect(text).not.toMatch(/fuck/i);
  });

  it("says a device that ran out of memory couldn't check the pull, not that it's fake, and tries again", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const raw = 'RangeError: WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance';
    vi.mocked(checkPull).mockReset().mockRejectedValueOnce(new TicketMemoryError(raw)).mockResolvedValueOnce(pull('Pack Ripper'));
    await act(async () => root.render(<PullViewerPage proof="proof" onClose={() => {}} />));
    const text = document.body.textContent ?? '';
    expect(text).toContain(OUT_OF_MEMORY_ADVICE);
    expect(text).not.toContain('Not a valid pull');
    expect(text).not.toContain('made up');
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Try again'));
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(checkPull).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('Verified on this device');
  });

  it('still calls a pull that fails its checks not valid', async () => {
    vi.mocked(checkPull).mockReset().mockRejectedValueOnce(new Error('Bad signature'));
    await act(async () => root.render(<PullViewerPage proof="proof" onClose={() => {}} />));
    const text = document.body.textContent ?? '';
    expect(text).toContain('Not a valid pull');
    expect(text).toContain('Bad signature');
    expect(text).not.toContain('Try again');
  });

  it('retires verified pull A immediately when navigating to pending pull B and does not leak A preview', async () => {
    let resolveB!: (val: CheckedPull) => void;
    const pendingB = new Promise<CheckedPull>((res) => { resolveB = res; });

    const pullA = pull('Player A');
    const pullB = { ...pull('Player B'), fingerprint: 'ef01', score: { hand: { name: 'Royal Flush' } } } as unknown as CheckedPull;

    vi.mocked(checkPull).mockReset().mockResolvedValueOnce(pullA);
    vi.mocked(previewFor).mockImplementation((cards) => cards === pullA.cardsWithMeta ? 'preview-A' : 'preview-B');

    await act(async () => root.render(<PullViewerPage proof="proofA" onClose={() => {}} />));
    expect(document.body.textContent).toContain('Full House');
    expect(document.body.textContent).toContain('Player A #abcd');

    // Copy link on A uses proofA and preview-A
    const copyBtnA = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy link'));
    expect(copyBtnA).toBeDefined();
    await act(async () => copyBtnA!.click());
    expect(pullUrl).toHaveBeenCalledWith('proofA', 'preview-A');

    // Switch proof prop to proofB while checkPull is in-flight
    vi.mocked(checkPull).mockReturnValueOnce(pendingB);
    await act(async () => root.render(<PullViewerPage proof="proofB" onClose={() => {}} />));

    // Checking state shown immediately; A's hand, player and cert are gone
    expect(document.body.textContent).toContain('Re-opening the pack on your device');
    expect(document.body.textContent).not.toContain('Full House');
    expect(document.body.textContent).not.toContain('Player A');
    expect(document.body.textContent).not.toContain('#abcd');
    // Copy button is retired during checking
    expect([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy link'))).toBeUndefined();

    // Now B resolves
    await act(async () => resolveB(pullB));
    expect(document.body.textContent).toContain('Royal Flush');
    expect(document.body.textContent).toContain('Player B #ef01');

    const copyBtnB = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy link'));
    expect(copyBtnB).toBeDefined();
    await act(async () => copyBtnB!.click());
    expect(pullUrl).toHaveBeenCalledWith('proofB', 'preview-B');
  });

  it('retires invalid state A immediately when proof prop changes to B', async () => {
    let resolveB!: (val: CheckedPull) => void;
    const pendingB = new Promise<CheckedPull>((res) => { resolveB = res; });

    vi.mocked(checkPull).mockReset().mockRejectedValueOnce(new Error('Corrupt signature'));
    await act(async () => root.render(<PullViewerPage proof="proofA" onClose={() => {}} />));
    expect(document.body.textContent).toContain('Corrupt signature');

    // Switch to proofB
    vi.mocked(checkPull).mockReturnValueOnce(pendingB);
    await act(async () => root.render(<PullViewerPage proof="proofB" onClose={() => {}} />));

    // Error from A is immediately retired
    expect(document.body.textContent).toContain('Re-opening the pack on your device');
    expect(document.body.textContent).not.toContain('Corrupt signature');
    expect(document.body.textContent).not.toContain('Not a valid pull');

    // Clean resolve of B
    await act(async () => resolveB(pull('Player B')));
    expect(document.body.textContent).toContain('Verified on this device');
  });

  it('retires memory-error state A (and its Try again) immediately when proof prop changes to B', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let resolveB!: (val: CheckedPull) => void;
    const pendingB = new Promise<CheckedPull>((res) => { resolveB = res; });

    vi.mocked(checkPull).mockReset().mockRejectedValueOnce(new TicketMemoryError('Out of memory'));
    await act(async () => root.render(<PullViewerPage proof="proofA" onClose={() => {}} />));
    expect(document.body.textContent).toContain(OUT_OF_MEMORY_ADVICE);

    vi.mocked(checkPull).mockReturnValueOnce(pendingB);
    await act(async () => root.render(<PullViewerPage proof="proofB" onClose={() => {}} />));

    expect(document.body.textContent).toContain('Re-opening the pack on your device');
    expect(document.body.textContent).not.toContain(OUT_OF_MEMORY_ADVICE);
    expect([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Try again'))).toBeUndefined();

    await act(async () => resolveB(pull('Player B')));
    expect(document.body.textContent).toContain('Verified on this device');
    expect(document.body.textContent).toContain('Player B');
  });

  it('ignores a late completion of aborted pull A while B is still checking', async () => {
    let resolveA!: (val: CheckedPull) => void;
    let resolveB!: (val: CheckedPull) => void;
    const pendingA = new Promise<CheckedPull>((res) => { resolveA = res; });
    const pendingB = new Promise<CheckedPull>((res) => { resolveB = res; });

    vi.mocked(checkPull).mockReset().mockReturnValueOnce(pendingA).mockReturnValueOnce(pendingB);
    await act(async () => root.render(<PullViewerPage proof="proofA" onClose={() => {}} />));
    await act(async () => root.render(<PullViewerPage proof="proofB" onClose={() => {}} />));
    // The effect cleanup aborted A's check.
    expect(vi.mocked(checkPull).mock.calls[0][1]?.aborted).toBe(true);

    // A finishes late: B stays in the checking state, nothing of A shows.
    await act(async () => resolveA(pull('Player A')));
    expect(document.body.textContent).toContain('Re-opening the pack on your device');
    expect(document.body.textContent).not.toContain('Player A');
    expect(document.body.textContent).not.toContain('Verified on this device');

    await act(async () => resolveB(pull('Player B')));
    expect(document.body.textContent).toContain('Player B');
    expect(document.body.textContent).not.toContain('Player A');
  });
});
