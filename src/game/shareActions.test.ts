import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canCopyImage, canShareTo, copyImage, copyText, saveImage, shareTo } from './shareActions';

describe('shareActions', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('copyText', () => {
    it('returns true when clipboard.writeText succeeds', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', {
        clipboard: { writeText: writeTextMock },
      });

      const result = await copyText('test text');

      expect(writeTextMock).toHaveBeenCalledWith('test text');
      expect(result).toBe(true);
    });

    it('falls back to window.prompt and returns false when clipboard.writeText fails', async () => {
      const writeTextMock = vi.fn().mockRejectedValue(new Error('Permission denied'));
      const promptMock = vi.fn();
      vi.stubGlobal('navigator', {
        clipboard: { writeText: writeTextMock },
      });
      vi.stubGlobal('window', { prompt: promptMock });

      const result = await copyText('test text');

      expect(promptMock).toHaveBeenCalledWith('Copy this:', 'test text');
      expect(result).toBe(false);
    });

    it('falls back to window.prompt when navigator.clipboard is missing', async () => {
      const promptMock = vi.fn();
      vi.stubGlobal('navigator', {});
      vi.stubGlobal('window', { prompt: promptMock });

      const result = await copyText('test text');

      expect(promptMock).toHaveBeenCalledWith('Copy this:', 'test text');
      expect(result).toBe(false);
    });
  });

  describe('canCopyImage', () => {
    it('returns false when ClipboardItem is undefined', () => {
      vi.stubGlobal('ClipboardItem', undefined);
      vi.stubGlobal('navigator', {
        clipboard: { write: vi.fn() },
      });

      expect(canCopyImage()).toBe(false);
    });

    it('returns false when navigator.clipboard.write is not a function', () => {
      class DummyClipboardItem {}
      vi.stubGlobal('ClipboardItem', DummyClipboardItem);
      vi.stubGlobal('navigator', { clipboard: {} });

      expect(canCopyImage()).toBe(false);
    });

    it('returns true when ClipboardItem and write exist but supports is missing', () => {
      class DummyClipboardItem {}
      vi.stubGlobal('ClipboardItem', DummyClipboardItem);
      vi.stubGlobal('navigator', {
        clipboard: { write: vi.fn() },
      });

      expect(canCopyImage()).toBe(true);
    });

    it('returns supports result when ClipboardItem.supports is a function', () => {
      class DummyClipboardItem {
        static supports = vi.fn((type: string) => type === 'image/png');
      }
      vi.stubGlobal('ClipboardItem', DummyClipboardItem);
      vi.stubGlobal('navigator', {
        clipboard: { write: vi.fn() },
      });

      expect(canCopyImage()).toBe(true);
      expect(DummyClipboardItem.supports).toHaveBeenCalledWith('image/png');

      DummyClipboardItem.supports.mockReturnValue(false);
      expect(canCopyImage()).toBe(false);
    });

    it('returns false when an error occurs in canCopyImage', () => {
      class DummyClipboardItem {
        static get supports() {
          throw new Error('Unexpected error');
        }
      }
      vi.stubGlobal('ClipboardItem', DummyClipboardItem);
      vi.stubGlobal('navigator', {
        clipboard: { write: vi.fn() },
      });

      expect(canCopyImage()).toBe(false);
    });
  });

  describe('copyImage', () => {
    it('returns true when navigator.clipboard.write succeeds with ClipboardItem', async () => {
      const writeMock = vi.fn().mockResolvedValue(undefined);
      class DummyClipboardItem {
        items: Record<string, Blob>;
        constructor(items: Record<string, Blob>) {
          this.items = items;
        }
      }
      vi.stubGlobal('ClipboardItem', DummyClipboardItem);
      vi.stubGlobal('navigator', {
        clipboard: { write: writeMock },
      });

      const blob = new Blob(['image data'], { type: 'image/png' });
      const result = await copyImage(blob);

      expect(result).toBe(true);
      expect(writeMock).toHaveBeenCalledTimes(1);
      const passedItems = writeMock.mock.calls[0][0];
      expect(passedItems[0]).toBeInstanceOf(DummyClipboardItem);
      expect(passedItems[0].items).toHaveProperty('image/png', blob);
    });

    it('uses image/png as default mime type if blob.type is empty', async () => {
      const writeMock = vi.fn().mockResolvedValue(undefined);
      class DummyClipboardItem {
        items: Record<string, Blob>;
        constructor(items: Record<string, Blob>) {
          this.items = items;
        }
      }
      vi.stubGlobal('ClipboardItem', DummyClipboardItem);
      vi.stubGlobal('navigator', {
        clipboard: { write: writeMock },
      });

      const blob = new Blob(['image data'], { type: '' });
      const result = await copyImage(blob);

      expect(result).toBe(true);
      expect(writeMock.mock.calls[0][0][0].items).toHaveProperty('image/png', blob);
    });

    it('returns false when navigator.clipboard.write fails', async () => {
      class DummyClipboardItem {
        constructor(public items: Record<string, Blob>) {}
      }
      vi.stubGlobal('ClipboardItem', DummyClipboardItem);
      vi.stubGlobal('navigator', {
        clipboard: { write: vi.fn().mockRejectedValue(new Error('Copy failed')) },
      });

      const blob = new Blob(['image data'], { type: 'image/png' });
      const result = await copyImage(blob);

      expect(result).toBe(false);
    });
  });

  describe('saveImage', () => {
    it('creates an anchor, sets href and download, clicks it, and revokes object URL after timeout', () => {
      vi.useFakeTimers();

      const createObjectURLMock = vi.fn().mockReturnValue('blob:http://localhost/fake-blob');
      const revokeObjectURLMock = vi.fn();
      vi.stubGlobal('URL', {
        createObjectURL: createObjectURLMock,
        revokeObjectURL: revokeObjectURLMock,
      });

      const clickMock = vi.fn();
      const anchorElement = {
        href: '',
        download: '',
        click: clickMock,
      };

      const createElementMock = vi.fn().mockReturnValue(anchorElement);
      vi.stubGlobal('document', {
        createElement: createElementMock,
      });

      const blob = new Blob(['test image']);
      saveImage(blob, 'card-reveal.png');

      expect(createElementMock).toHaveBeenCalledWith('a');
      expect(createObjectURLMock).toHaveBeenCalledWith(blob);
      expect(anchorElement.href).toBe('blob:http://localhost/fake-blob');
      expect(anchorElement.download).toBe('card-reveal.png');
      expect(clickMock).toHaveBeenCalledTimes(1);

      expect(revokeObjectURLMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);

      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:http://localhost/fake-blob');
    });
  });

  describe('canShareTo', () => {
    it('returns true when navigator.share is a function and coarse pointer matches', () => {
      vi.stubGlobal('navigator', { share: vi.fn() });
      vi.stubGlobal('window', {
        matchMedia: vi.fn((query: string) => ({
          matches: query === '(pointer: coarse)',
        })),
      });

      expect(canShareTo()).toBe(true);
    });

    it('returns false when navigator.share is missing', () => {
      vi.stubGlobal('navigator', {});
      vi.stubGlobal('window', {
        matchMedia: vi.fn((query: string) => ({
          matches: query === '(pointer: coarse)',
        })),
      });

      expect(canShareTo()).toBe(false);
    });

    it('returns false when matchMedia is missing on window', () => {
      vi.stubGlobal('navigator', { share: vi.fn() });
      vi.stubGlobal('window', {});

      expect(canShareTo()).toBe(false);
    });

    it('returns false when coarse pointer does not match', () => {
      vi.stubGlobal('navigator', { share: vi.fn() });
      vi.stubGlobal('window', {
        matchMedia: vi.fn().mockReturnValue({ matches: false }),
      });

      expect(canShareTo()).toBe(false);
    });

    /** A device whose primary pointer is fine (a trackpad or mouse) and that also has a touchscreen. */
    const fineWithTouchscreen = (userAgent: string, maxTouchPoints: number) => {
      vi.stubGlobal('navigator', { share: vi.fn(), userAgent, maxTouchPoints });
      vi.stubGlobal('window', {
        matchMedia: vi.fn((query: string) => ({ matches: query === '(any-pointer: coarse)' })),
      });
    };

    it('offers the share sheet on an iPad with a trackpad, which reports itself as a Mac', () => {
      fineWithTouchscreen('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 5);
      expect(canShareTo()).toBe(true);
    });

    it('offers the share sheet on an Android tablet with a mouse', () => {
      fineWithTouchscreen('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/125.0 Safari/537.36', 10);
      expect(canShareTo()).toBe(true);
    });

    it('keeps a touchscreen laptop on copy only', () => {
      fineWithTouchscreen('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36 Edg/125.0', 10);
      expect(canShareTo()).toBe(false);
    });

    it('keeps a Mac on copy only', () => {
      vi.stubGlobal('navigator', {
        share: vi.fn(),
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
        maxTouchPoints: 0,
      });
      vi.stubGlobal('window', { matchMedia: vi.fn().mockReturnValue({ matches: false }) });
      expect(canShareTo()).toBe(false);
    });

    it('does not trust a phone user agent without a touchscreen', () => {
      vi.stubGlobal('navigator', { share: vi.fn(), userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 0 });
      vi.stubGlobal('window', { matchMedia: vi.fn().mockReturnValue({ matches: false }) });
      expect(canShareTo()).toBe(false);
    });
  });

  describe('shareTo', () => {
    it('shares file when image is provided and canShare accepts files', async () => {
      const shareMock = vi.fn().mockResolvedValue(undefined);
      const canShareMock = vi.fn().mockReturnValue(true);
      vi.stubGlobal('navigator', {
        share: shareMock,
        canShare: canShareMock,
      });

      const blob = new Blob(['image payload'], { type: 'image/png' });
      const result = await shareTo({
        title: 'Check this out',
        text: 'Look at my card!',
        url: 'https://example.com/card',
        image: { blob, filename: 'card.png' },
      });

      expect(result).toBe('shared');
      expect(canShareMock).toHaveBeenCalledTimes(1);
      const canShareArg = canShareMock.mock.calls[0][0];

      expect(shareMock).toHaveBeenCalledTimes(1);
      const shareArg = shareMock.mock.calls[0][0];

      const sharedFile = shareArg.files[0];
      expect(canShareArg).toEqual({ files: [sharedFile] });
      expect(sharedFile.name).toBe('card.png');
      expect(sharedFile.type).toBe('image/png');
      expect(await sharedFile.text()).toBe('image payload');
      expect(shareArg.text).toBe('https://example.com/card');
    });

    it('falls back to text when share.url is missing during file share', async () => {
      const shareMock = vi.fn().mockResolvedValue(undefined);
      const canShareMock = vi.fn().mockReturnValue(true);
      vi.stubGlobal('navigator', {
        share: shareMock,
        canShare: canShareMock,
      });

      const blob = new Blob(['image payload'], { type: 'image/png' });
      const result = await shareTo({
        title: 'Check this out',
        text: 'Look at my card!',
        image: { blob, filename: 'card.png' },
      });

      expect(result).toBe('shared');
      expect(shareMock).toHaveBeenCalledWith({
        files: [expect.any(File)],
        text: 'Look at my card!',
      });
    });

    it('falls back to URL/text share when file sharing is not supported by navigator.canShare', async () => {
      const shareMock = vi.fn().mockResolvedValue(undefined);
      const canShareMock = vi.fn().mockReturnValue(false);
      vi.stubGlobal('navigator', {
        share: shareMock,
        canShare: canShareMock,
      });

      const blob = new Blob(['image payload'], { type: 'image/png' });
      const result = await shareTo({
        title: 'Check this out',
        text: 'Look at my card!',
        url: 'https://example.com/card',
        image: { blob, filename: 'card.png' },
      });

      expect(result).toBe('shared');
      expect(canShareMock).toHaveBeenCalled();
      expect(shareMock).toHaveBeenCalledWith({
        title: 'Check this out',
        text: 'Look at my card!',
        url: 'https://example.com/card',
      });
    });

    it('shares URL/text directly when no image is provided', async () => {
      const shareMock = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', {
        share: shareMock,
      });

      const result = await shareTo({
        title: 'Check this out',
        text: 'Look at my card!',
        url: 'https://example.com/card',
      });

      expect(result).toBe('shared');
      expect(shareMock).toHaveBeenCalledWith({
        title: 'Check this out',
        text: 'Look at my card!',
        url: 'https://example.com/card',
      });
    });

    it('returns cancelled when sharing fails due to AbortError DOMException', async () => {
      const shareMock = vi.fn().mockRejectedValue(new DOMException('User cancelled', 'AbortError'));
      vi.stubGlobal('navigator', {
        share: shareMock,
      });

      const result = await shareTo({
        title: 'Title',
        text: 'Text',
      });

      expect(result).toBe('cancelled');
    });

    it('returns failed when sharing fails with a non-AbortError', async () => {
      const shareMock = vi.fn().mockRejectedValue(new Error('Permission denied'));
      vi.stubGlobal('navigator', {
        share: shareMock,
      });

      const result = await shareTo({
        title: 'Title',
        text: 'Text',
      });

      expect(result).toBe('failed');
    });
  });
});
