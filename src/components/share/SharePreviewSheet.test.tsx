// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as shareActions from '../../game/shareActions';
import SharePreviewSheet from './SharePreviewSheet';

vi.mock('../../game/shareActions', () => ({
  canCopyImage: vi.fn(() => false),
  canShareTo: vi.fn(() => false),
  copyImage: vi.fn(async () => true),
  copyText: vi.fn(async () => true),
  saveImage: vi.fn(),
  shareTo: vi.fn(async () => 'shared'),
}));

const poster = new Blob(['poster'], { type: 'image/png' });
let root: Root;
let container: HTMLElement;
let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom has no object URLs; the preview only needs a src string.
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:poster'; }
    static revokeObjectURL() {}
  });
  vi.mocked(shareActions.canCopyImage).mockReturnValue(false);
  onClose = vi.fn<() => void>();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Render the sheet and let the poster finish drawing. */
const open = async (props?: Partial<React.ComponentProps<typeof SharePreviewSheet>>) => {
  await act(async () => root.render(
    <SharePreviewSheet title="Share your pull" makeImage={async () => poster} imageName="pull.png" url="https://example.invalid/#/pull/abc"
      text="Look at this pull" onClose={onClose}
      actions={<p className="test-actions">Hall of Fame</p>}
      {...props}>
      <p className="test-extra">Cards in this pack</p>
    </SharePreviewSheet>,
  ));
};
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.share-sheet button')]
  .find((el) => el.textContent?.trim() === label)!;
const done = () => document.querySelector('.share-done')!.textContent;
const isDoneFailed = () => document.querySelector('.share-done')!.classList.contains('is-failed');

describe('share preview actions', () => {
  it('copies the link and says so', async () => {
    await open();
    await act(async () => button('Copy link').click());
    expect(shareActions.copyText).toHaveBeenCalledWith('https://example.invalid/#/pull/abc');
    expect(done()).toBe('Link copied');
  });

  it('saves the poster when this browser cannot copy images', async () => {
    await open();
    await act(async () => button('Save image').click());
    expect(shareActions.saveImage).toHaveBeenCalledWith(poster, 'pull.png');
    expect(shareActions.copyImage).not.toHaveBeenCalled();
    expect(done()).toBe('Image saved');
  });

  it('copies the poster when this browser can', async () => {
    vi.mocked(shareActions.canCopyImage).mockReturnValue(true);
    await open();
    await act(async () => button('Copy image').click());
    expect(shareActions.copyImage).toHaveBeenCalledWith(poster);
    expect(shareActions.saveImage).not.toHaveBeenCalled();
    expect(done()).toBe('Image copied');
  });

  it('closes on Escape', async () => {
    await open();
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps extra actions with the share buttons, ahead of the preview, and other content after it', async () => {
    await open();
    const order = ['.share-actions-main', '.test-actions', '.share-preview', '.test-extra'].map((s) => document.querySelector(s)!);
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe('native sharing failure and recovery', () => {
  beforeEach(() => {
    vi.mocked(shareActions.canShareTo).mockReturnValue(true);
  });

  it('explains sharing failed and directs to Copy image, Save image or Copy text when native share fails without a URL and images can be copied', async () => {
    vi.mocked(shareActions.canCopyImage).mockReturnValue(true);
    vi.mocked(shareActions.shareTo).mockResolvedValue('failed');
    await open({ url: undefined });

    await act(async () => button('Share to…').click());

    expect(shareActions.shareTo).toHaveBeenCalledWith({
      url: undefined,
      text: 'Look at this pull',
      title: 'Share your pull',
      image: { blob: poster, filename: 'pull.png' },
    });
    expect(done()).toBe('Sharing failed — use Copy image, Save image or Copy text');
    expect(isDoneFailed()).toBe(true);
    expect(shareActions.saveImage).not.toHaveBeenCalled();
    expect(shareActions.copyText).not.toHaveBeenCalled();
  });

  it('explains sharing failed and directs to Save image or Copy text when native share fails without a URL and images cannot be copied', async () => {
    vi.mocked(shareActions.canCopyImage).mockReturnValue(false);
    vi.mocked(shareActions.shareTo).mockResolvedValue('failed');
    await open({ url: undefined });

    await act(async () => button('Share to…').click());

    expect(done()).toBe('Sharing failed — use Save image or Copy text');
    expect(isDoneFailed()).toBe(true);
    expect(shareActions.saveImage).not.toHaveBeenCalled();
    expect(shareActions.copyText).not.toHaveBeenCalled();
  });

  it('recovers by copying the link when native sharing fails for a share with a URL', async () => {
    vi.mocked(shareActions.shareTo).mockResolvedValue('failed');
    await open({ url: 'https://example.invalid/#/pull/abc' });

    await act(async () => button('Share to…').click());

    expect(shareActions.copyText).toHaveBeenCalledWith('https://example.invalid/#/pull/abc');
    expect(done()).toBe('Link copied');
    expect(isDoneFailed()).toBe(false);
  });

  it('keeps quiet and does not download or claim success on user cancellation', async () => {
    vi.mocked(shareActions.shareTo).mockResolvedValue('cancelled');
    await open({ url: undefined });

    await act(async () => button('Share to…').click());

    expect(done()).toBe('');
    expect(isDoneFailed()).toBe(false);
    expect(shareActions.saveImage).not.toHaveBeenCalled();
    expect(shareActions.copyText).not.toHaveBeenCalled();
  });

  it('keeps retry usable and clears failure guidance when retry succeeds', async () => {
    vi.mocked(shareActions.canCopyImage).mockReturnValue(false);
    vi.mocked(shareActions.shareTo).mockResolvedValueOnce('failed');
    await open({ url: undefined });

    await act(async () => button('Share to…').click());
    expect(done()).toBe('Sharing failed — use Save image or Copy text');
    expect(isDoneFailed()).toBe(true);

    vi.mocked(shareActions.shareTo).mockResolvedValueOnce('shared');
    await act(async () => button('Share to…').click());

    expect(done()).toBe('');
    expect(isDoneFailed()).toBe(false);
  });

  it('clears failure guidance when player chooses an alternative action like Save image', async () => {
    vi.mocked(shareActions.canCopyImage).mockReturnValue(false);
    vi.mocked(shareActions.shareTo).mockResolvedValue('failed');
    await open({ url: undefined });

    await act(async () => button('Share to…').click());
    expect(isDoneFailed()).toBe(true);

    await act(async () => button('Save image').click());
    expect(done()).toBe('Image saved');
    expect(isDoneFailed()).toBe(false);
    expect(shareActions.saveImage).toHaveBeenCalledWith(poster, 'pull.png');
  });
});
