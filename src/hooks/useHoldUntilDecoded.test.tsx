// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admitOptional, resetAdmission } from '../game/admission';
import { SUMMARY_DECODE_CAP_MS, useHoldUntilDecoded } from './useHoldUntilDecoded';

let root: Root;
let decoded: () => void;

const Summary = ({ active = true }: { active?: boolean }) => {
  const ref = useRef<HTMLUListElement>(null);
  useHoldUntilDecoded(ref, active);
  return <ul ref={ref}><li><img alt="" /></li><li><img alt="" /></li></ul>;
};
const render = (node: React.ReactNode) => act(() => root.render(node));
/** Optional work queued now, and whether it has started. */
const queue = () => {
  const work = vi.fn(async () => {});
  void admitOptional(work);
  return work;
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetAdmission();
  // Both images decode together, when the test says so.
  const pending = new Promise<void>((resolve) => { decoded = resolve; });
  // jsdom has no decode(), so give images one for the test.
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: () => pending });
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('holding optional work until the summary decodes', () => {
  it('starts it once the cards have decoded', async () => {
    await render(<Summary />);
    const work = queue();
    await act(async () => {});
    expect(work).not.toHaveBeenCalled();

    await act(async () => decoded());
    expect(work).toHaveBeenCalledOnce();
  });

  it('starts it after the cap when decoding never finishes', async () => {
    vi.useFakeTimers();
    await render(<Summary />);
    const work = queue();
    await act(async () => vi.advanceTimersByTime(SUMMARY_DECODE_CAP_MS - 1));
    expect(work).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(1));
    expect(work).toHaveBeenCalledOnce();
  });

  it('starts it when the summary is left, or a sheet covers it', async () => {
    await render(<Summary />);
    const left = queue();
    await render(null);
    await act(async () => {});
    expect(left).toHaveBeenCalledOnce();

    await render(<Summary />);
    const covered = queue();
    await render(<Summary active={false} />);
    await act(async () => {});
    expect(covered).toHaveBeenCalledOnce();
  });
});
