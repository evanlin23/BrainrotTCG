// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderCardPoster, type CardPosterInput } from './bragImage';

const { holdFinishedCardImage } = vi.hoisted(() => ({
  // Like the real one: the plain address without a finish, a render of it with one.
  holdFinishedCardImage: vi.fn((src: string, finish?: string | null) => ({
    image: Promise.resolve(finish ? `rendered:${src}` : src),
    release: () => {},
  })),
}));
vi.mock('./finishImage', () => ({ holdFinishedCardImage }));

/** Every address an Image was pointed at while a poster was drawn. */
let requested: string[];
/** Every line of text drawn on the poster. */
let texts: string[];

class RecordingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 687;
  naturalHeight = 1024;
  set src(value: string) {
    requested.push(value);
    queueMicrotask(() => this.onload?.());
  }
}

/** A canvas context that accepts any drawing call, so only the image loading is observed. */
const sink = (): unknown => new Proxy(function sinkTarget() {}, { get: () => sink(), apply: () => sink(), set: () => true });
const context = () => new Proxy({ measureText: () => ({ width: 100 }), fillText: (text: string) => texts.push(text) } as Record<string, unknown>, {
  get: (target, key: string) => (key in target ? target[key] : sink()),
  set: () => true,
});

beforeEach(() => {
  requested = [];
  texts = [];
  holdFinishedCardImage.mockClear();
  vi.stubGlobal('Image', RecordingImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context() as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['png'], { type: 'image/png' })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const poster = (image: string, finish?: 'GOLD'): CardPosterInput => ({
  card: { image, name: 'Old Card', isHolo: false, finish, rarityName: 'Common', raritySymbol: '●', rarityColor: '#999', number: '#001' },
  setName: 'Archive', setCode: 'ARC', playerName: 'Tester', fingerprint: 'abc123',
});

it.each([
  ['an external address', 'https://tracker.example/pixel.gif?id=1'],
  ['a protocol-relative address', '//tracker.example/pixel.gif'],
  ['a data: URL', 'data:image/svg+xml,<svg/>'],
])('draws a card poster for %s without requesting it, with or without a finish', async (_name, image) => {
  for (const finish of [undefined, 'GOLD' as const]) {
    const blob = await renderCardPoster(poster(image, finish));
    expect(blob.type).toBe('image/png');
  }
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.filter((src) => !src.startsWith('data:image/gif;base64,'))).toEqual([]);
  expect(holdFinishedCardImage).not.toHaveBeenCalledWith(image, expect.anything());
});

it('still loads archived art on this site, and its finish', async () => {
  await renderCardPoster(poster('/BrainrotTCG/assets/old-1a2b.webp'));
  expect(requested).toEqual(['/BrainrotTCG/assets/old-1a2b.webp']);
  requested = [];
  await renderCardPoster(poster('/old.webp', 'GOLD'));
  expect(holdFinishedCardImage).toHaveBeenCalledWith('/old.webp', 'GOLD');
  expect(requested).toEqual(['rendered:/old.webp']);
});

it('labels a card poster with no pack link neutrally, without claiming it predates verifiable pulls', async () => {
  await renderCardPoster(poster('/old.webp'));
  expect(texts).toContain('No pack record on this device.');
  expect(texts.join('\n')).not.toContain('before verifiable pulls');
  texts = [];
  await renderCardPoster({ ...poster('/old.webp'), url: 'https://example.test/#/pull/x' });
  expect(texts).toContain('Scan to re-open the pack it came from.');
  expect(texts).not.toContain('No pack record on this device.');
});
