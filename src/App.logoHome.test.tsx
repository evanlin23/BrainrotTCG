// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';

const opener = vi.hoisted(() => ({ onBusyChange: undefined as undefined | ((busy: boolean) => void) }));
vi.mock('./components/pack/PackOpener', () => ({
  default: (props: { onBusyChange: (busy: boolean) => void }) => {
    opener.onBusyChange = props.onBusyChange;
    return null;
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  localStorage.clear();
  window.location.hash = '#/settings';
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = '';
});

const logo = () => document.querySelector<HTMLAnchorElement>('a[aria-label="Brainrot TCG, home"]');
const click = (init: MouseEventInit = {}) => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => { logo()!.dispatchEvent(event); });
  return event;
};

it('is a home link on a page, with one h1 in the view', () => {
  expect(logo()).not.toBeNull();
  expect(logo()!.getAttribute('href')).toBe(import.meta.env.BASE_URL);
  expect(document.querySelectorAll('h1')).toHaveLength(1);
});

it('goes to the Packs screen on a plain click, and leaves modified clicks to the browser', () => {
  expect(click({ ctrlKey: true }).defaultPrevented).toBe(false);
  expect(window.location.hash).toBe('#/settings');
  expect(click().defaultPrevented).toBe(true);
  expect(window.location.hash).not.toBe('#/settings');
  // Back on the packs screen the logo is the h1, not a link.
  expect(logo()).toBeNull();
  expect(document.querySelectorAll('h1')).toHaveLength(1);
});

it('stays a working link while a pack is busy, like the Packs tab', async () => {
  await act(async () => opener.onBusyChange?.(true));
  expect(logo()!.hasAttribute('aria-disabled')).toBe(false);
  expect(logo()!.tabIndex).toBe(0);
  click();
  expect(window.location.hash).not.toBe('#/settings');
});
