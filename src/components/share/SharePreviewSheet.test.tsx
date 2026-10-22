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
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
const open = async () => {
  await act(async () => root.render(
    <SharePreviewSheet title="Share your pull" makeImage={async () => poster} imageName="pull.png" url="https://example.invalid/#/pull/abc"
      text="Look at this pull" onClose={onClose}
      actions={<p className="test-actions">Hall of Fame</p>}>
      <p className="test-extra">Cards in this pack</p>
    </SharePreviewSheet>,
  ));
};
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.share-actions-main button')]
  .find((el) => el.textContent?.trim() === label)!;
const done = () => document.querySelector('.share-done')!.textContent;

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

  it('shows actionable failure with Retry when draw fails, preserving text/link sharing, and recovers on Retry', async () => {
    let shouldFail = true;
    const makeImage = vi.fn(async () => {
      if (shouldFail) throw new Error('Network failure loading card art');
      return poster;
    });

    await act(async () => {
      root.render(
        <SharePreviewSheet
          title="Share card"
          makeImage={makeImage}
          imageName="card.png"
          url="https://example.invalid/#/pull/test"
          text="Check this card"
          onClose={onClose}
        />,
      );
    });

    // Drawing failed: shows failure message and Retry button
    const waitSpan = document.querySelector('.share-preview-wait')!;
    expect(waitSpan.textContent).toContain("Couldn't draw the image");
    const retryBtn = document.querySelector<HTMLButtonElement>('.share-retry-btn');
    expect(retryBtn).not.toBeNull();
    expect(retryBtn?.textContent).toBe('Retry');

    // Image buttons are disabled while text and link copying remain active
    expect(button('Save image').disabled).toBe(true);
    await act(async () => button('Copy link').click());
    expect(shareActions.copyText).toHaveBeenCalledWith('https://example.invalid/#/pull/test');
    expect(done()).toBe('Link copied');

    // Click Retry once the network/image is available
    shouldFail = false;
    await act(async () => {
      retryBtn?.click();
    });

    // Fresh attempt succeeds
    expect(makeImage).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.share-preview img')).not.toBeNull();
    expect(document.querySelector('.share-retry-btn')).toBeNull();
    expect(button('Save image').disabled).toBe(false);
  });

  it('cancels late completion when sheet is closed while image draw is pending', async () => {
    let resolveImage!: (blob: Blob) => void;
    const makeImage = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          resolveImage = resolve;
        }),
    );
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');

    await act(async () => {
      root.render(
        <SharePreviewSheet
          title="Share card"
          makeImage={makeImage}
          imageName="card.png"
          url="https://example.invalid/#/pull/test"
          text="Check this card"
          onClose={onClose}
        />,
      );
    });

    expect(document.querySelector('.share-preview-wait')?.textContent).toBe('Drawing the image…');

    // Sheet unmounts (closes) while image is still drawing
    act(() => root.unmount());

    // Late resolution should be cleanly ignored without errors
    await act(async () => {
      resolveImage(poster);
    });

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
