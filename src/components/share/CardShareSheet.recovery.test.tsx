// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSetCards } from '../../data/cards';
import { POSTER_IMAGE_TIMEOUT_MS } from '../../game/bragImage';
import * as shareActions from '../../game/shareActions';
import CardShareSheet from './CardShareSheet';

vi.mock('../../game/shareActions', () => ({
  canCopyImage: vi.fn(() => false),
  canShareTo: vi.fn(() => false),
  copyImage: vi.fn(async () => true),
  copyText: vi.fn(async () => true),
  saveImage: vi.fn(),
  shareTo: vi.fn(async () => 'shared'),
}));

class ControlledImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  naturalWidth = 687;
  naturalHeight = 1024;

  constructor() {
    controlledImages.push(this);
  }

  load() {
    this.onload?.();
  }

  fail() {
    this.onerror?.();
  }
}

let controlledImages: ControlledImage[];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:bukangi-poster'; }
    static revokeObjectURL() {}
  });

  controlledImages = [];
  vi.stubGlobal('Image', ControlledImage);

  const mockCtx = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 100 })),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clip: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    arcTo: vi.fn(),
    moveTo: vi.fn(),
    roundRect: vi.fn(),
    font: '',
    textAlign: 'left',
    fillStyle: '#fff',
    textBaseline: 'alphabetic',
  };

  HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));

  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('CardShareSheet ordinary card recovery (Bukangi)', () => {
  const bukangi = getSetCards('right-now').find((c) => c.id === 'bukangi')!;

  it('bounds held Bukangi image load, displays Retry while preserving text copy, and recovers on Retry', async () => {
    act(() => {
      root!.render(<CardShareSheet card={bukangi} version={{ isHolo: false, finish: null, misprint: false }} onClose={() => {}} />);
    });

    const statusWait = () => document.querySelector('.share-preview-wait');
    const saveButton = () => document.querySelector<HTMLButtonElement>('.share-actions-main button:last-child');
    const retryButton = () => document.querySelector<HTMLButtonElement>('.share-retry-btn');
    const copyTextButton = () => [...document.querySelectorAll<HTMLButtonElement>('.link-btn')]
      .find((b) => b.textContent?.includes('Copy text'));

    expect(statusWait()?.textContent).toBe('Drawing the image…');
    expect(saveButton()?.disabled).toBe(true);

    // Wait until bragImage.renderCardPoster starts the image load
    await vi.waitFor(() => expect(controlledImages).toHaveLength(1));
    const heldImg = controlledImages[0];
    expect(heldImg.src).toContain('bukangi');

    // Advance fake timer past the poster image deadline
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS);
    });

    // Drawing timed out: actionable failure message and Retry button appear
    expect(statusWait()?.textContent).toContain("Couldn't draw the image");
    expect(retryButton()).not.toBeNull();
    expect(saveButton()?.disabled).toBe(true);

    // Text copy remains fully operational
    await act(async () => {
      copyTextButton()?.click();
    });
    expect(shareActions.copyText).toHaveBeenCalled();
    expect(document.querySelector('.share-done')?.textContent).toBe('Text copied');

    // Release the held request and click Retry
    await act(async () => {
      retryButton()?.click();
    });

    // Second attempt starts
    await vi.waitFor(() => expect(controlledImages).toHaveLength(2));
    const retryImg = controlledImages[1];

    // Image now resolves successfully
    await act(async () => {
      retryImg.load();
    });

    // Drawing finishes: image is displayed and Save image enables
    expect(document.querySelector('.share-preview img')).not.toBeNull();
    expect(retryButton()).toBeNull();
    expect(saveButton()?.disabled).toBe(false);
  });

  it('reports immediate failure when image request errors, and recovers on Retry', async () => {
    act(() => {
      root!.render(<CardShareSheet card={bukangi} version={{ isHolo: false, finish: null, misprint: false }} onClose={() => {}} />);
    });

    await vi.waitFor(() => expect(controlledImages).toHaveLength(1));
    const failedImg = controlledImages[0];

    // Immediate network error
    await act(async () => {
      failedImg.fail();
    });

    expect(document.querySelector('.share-preview-wait')?.textContent).toContain("Couldn't draw the image");
    const retryButton = document.querySelector<HTMLButtonElement>('.share-retry-btn');
    expect(retryButton).not.toBeNull();

    // Click Retry
    await act(async () => {
      retryButton?.click();
    });

    await vi.waitFor(() => expect(controlledImages).toHaveLength(2));
    const retryImg = controlledImages[1];

    await act(async () => {
      retryImg.load();
    });

    expect(document.querySelector('.share-preview img')).not.toBeNull();
    expect(document.querySelector('.share-actions-main button:last-child')?.hasAttribute('disabled')).toBe(false);
  });
});
