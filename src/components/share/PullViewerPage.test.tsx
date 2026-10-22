// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkPull, type CheckedPull } from '../../game/pulls';
import { OUT_OF_MEMORY_ADVICE, TicketMemoryError } from '../../game/ticketPool';
import PullViewerPage from './PullViewerPage';

// The pull is a stand-in: this checks only how the player's name is shown.
vi.mock('../../game/pulls', () => ({ checkPull: vi.fn(), previewFor: vi.fn(), pullUrl: vi.fn(() => 'https://example.invalid/#/pull/proof') }));
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
    expect(text).not.toContain('pulled this pack');
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
    expect(text).not.toContain('pulled this pack');
  });

  const render = async (props: Partial<Parameters<typeof PullViewerPage>[0]>, name = 'Gurt') => {
    vi.mocked(checkPull).mockReset().mockResolvedValueOnce(pull(name));
    await act(async () => root.render(<PullViewerPage proof="proof" onClose={() => {}} {...props} />));
    return document.body.textContent ?? '';
  };
  const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

  it('says whose pull it is, and in which set, from the verified proof', async () => {
    expect(await render({})).toContain('Gurt pulled this pack in Original.');
  });

  it('says Someone, never the raw name, when the name is missing or blocked', async () => {
    expect(await render({}, '')).toContain('Someone pulled this pack in Original.');
    const blocked = await render({}, 'xXfuckXx');
    expect(blocked).toContain('Someone pulled this pack in Original.');
    expect(blocked).not.toMatch(/fuck/i);
  });

  it('names nobody before the pull is verified', async () => {
    vi.mocked(checkPull).mockReset().mockReturnValueOnce(new Promise(() => {}));
    await act(async () => root.render(<PullViewerPage proof="proof" onClose={() => {}} />));
    expect(document.body.textContent).not.toContain('pulled this pack');
  });

  it("offers to open the pull's own set when it can be opened, and chooses it", async () => {
    const onOpenSet = vi.fn();
    const onClose = vi.fn();
    const canOpenSet = vi.fn(() => true);
    await render({ canOpenSet, onOpenSet, onClose });
    expect(button('Open your own packs')).toBeUndefined();
    await act(async () => button('Open Original packs')!.click());
    expect(canOpenSet).toHaveBeenCalledWith(expect.objectContaining({ id: 'og', version: 1 }));
    expect(onOpenSet).toHaveBeenCalledWith('og');
  });

  it('falls back to the usual packs screen when the set cannot be opened', async () => {
    const onOpenSet = vi.fn();
    const onClose = vi.fn();
    await render({ canOpenSet: () => false, onOpenSet, onClose });
    expect(button('Open Original packs')).toBeUndefined();
    await act(async () => button('Open your own packs')!.click());
    expect(onOpenSet).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
