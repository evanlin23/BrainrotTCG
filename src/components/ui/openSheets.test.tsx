// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sheet from './Sheet';
import { closeSheet, isTopSheet, openSheet, useAnySheetOpen } from './openSheets';

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

function Probe() {
  return <output>{useAnySheetOpen() ? 'open' : 'closed'}</output>;
}
const probe = () => document.querySelector('output')!.textContent;

describe('the open-sheet store', () => {
  it('keeps the last one opened on top, and reports when the last one closes', () => {
    openSheet('a');
    openSheet('b');
    expect(isTopSheet('b')).toBe(true);
    expect(isTopSheet('a')).toBe(false);
    expect(closeSheet('b')).toBe(false);
    expect(isTopSheet('a')).toBe(true);
    expect(closeSheet('a')).toBe(true);
  });

  it('tells a subscriber while any sheet is on screen (so toasts wait for it, #803)', () => {
    act(() => root.render(<Probe />));
    expect(probe()).toBe('closed');
    act(() => root.render(<><Probe /><Sheet title="A card" onClose={() => {}} bare><p>Close-up</p></Sheet></>));
    expect(probe()).toBe('open');
    act(() => root.render(<Probe />));
    expect(probe()).toBe('closed');
  });
});
