// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkPull, type CheckedPull } from '../../game/pulls';
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
});
