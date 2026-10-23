// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vectors from '../../../spec/vectors.json';
import { checkPull } from '../../game/pulls';
import PackCardViewer from '../ui/PackCardViewer';
import PullViewerPage from './PullViewerPage';

// The real check, observed: the tests wait on its promise instead of polling the page.
vi.mock('../../game/pulls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../game/pulls')>();
  return { ...actual, checkPull: vi.fn(actual.checkPull) };
});

const vector = (note: string) => vectors.valid.find((v) => v.note === note)!;
const PAIR = vector('modifiers: a misprint'); // Pair x2, 4,925 pts, 9,850
const NO_MATCHES = vector('modifiers: a finish'); // No Matches, 260

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.mocked(checkPull).mockClear();
});

const open = async (proof: string) => {
  await act(async () => root.render(<PullViewerPage proof={proof} onClose={() => {}} />));
  await act(async () => {
    await vi.mocked(checkPull).mock.results[0].value;
  });
  return document.querySelector<HTMLElement>('.pull-viewer')!;
};

const count = (text: string, part: string) => text.split(part).length - 1;

describe('shared pull result (#639)', () => {
  it('shows a Pair once: combo in the title, multiplier in the score line, total and fingerprint once', async () => {
    const dialog = await open(PAIR.proof);
    const text = dialog.textContent ?? '';

    expect(dialog.querySelector('.sheet-title')!.textContent).toBe('Pair');
    expect(dialog.querySelector('.pack-headline')).toBeNull();
    expect(count(text, 'Pair')).toBe(1);
    expect(dialog.querySelector('.score-panel-total')!.textContent).toBe('9,850');
    expect(count(text, '9,850')).toBe(1);
    // The arithmetic stays, with the multiplier once and a clear label.
    expect(dialog.querySelector('.score-panel-math')!.textContent).toBe('Brainrot Score · 4,925 pts × 2');
    expect(count(text, '×')).toBe(1);
    expect(dialog.querySelector('.share-fp')).toBeNull();
    expect(count(text, PAIR.fingerprint)).toBe(1);
    expect(dialog.querySelector('.pull-viewer-cert')!.textContent).toContain(`Cert ${PAIR.fingerprint}`);
    // Verification, the card guide and the five-card fan are all still there.
    expect(text).toContain('This pull checks out');
    expect([...dialog.querySelectorAll('button')].some((b) => b.textContent?.includes('Card guide'))).toBe(true);
    expect(dialog.querySelectorAll('.pack-viewer-cards > button')).toHaveLength(PAIR.cards.length);
  });

  it('still says No Matches, once, with its total and fingerprint once', async () => {
    const dialog = await open(NO_MATCHES.proof);
    const text = dialog.textContent ?? '';

    expect(dialog.querySelector('.sheet-title')!.textContent).toBe('A pull');
    expect(dialog.querySelector('.pack-headline-combo')!.textContent).toBe('No Matches ×1');
    expect(count(text, 'No Matches')).toBe(1);
    expect(count(text, '260')).toBe(1);
    expect(dialog.querySelector('.score-panel-math')!.textContent).toBe('Brainrot Score');
    expect(count(text, NO_MATCHES.fingerprint)).toBe(1);
  });
});

describe('PackCardViewer titled (#639)', () => {
  it('keeps the combo headline without a title and drops only it with one', async () => {
    await act(async () => root.render(<PullViewerPage proof={PAIR.proof} onClose={() => {}} />));
    const { cardsWithMeta } = await vi.mocked(checkPull).mock.results[0].value;
    await act(async () => {});

    await act(async () => root.render(<PackCardViewer cards={cardsWithMeta} />));
    expect(container.querySelector('.pack-headline-combo')!.textContent).toBe('Pair ×2');
    expect(container.querySelector('.score-panel-total')!.textContent).toBe('9,850');

    await act(async () => root.render(<PackCardViewer cards={cardsWithMeta} titled />));
    expect(container.querySelector('.pack-headline')).toBeNull();
    expect(container.querySelector('.score-panel-total')!.textContent).toBe('9,850');
    expect(container.querySelector('.score-panel-math')!.textContent).toBe('Brainrot Score · 4,925 pts × 2');
  });

  it('keeps the No Matches headline even when told it is titled', async () => {
    await act(async () => root.render(<PullViewerPage proof={NO_MATCHES.proof} onClose={() => {}} />));
    const { cardsWithMeta } = await vi.mocked(checkPull).mock.results[0].value;
    await act(async () => {});

    await act(async () => root.render(<PackCardViewer cards={cardsWithMeta} titled />));
    expect(container.querySelector('.pack-headline-combo')!.textContent).toBe('No Matches ×1');
  });
});
