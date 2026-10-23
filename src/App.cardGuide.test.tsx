// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from './constants/config';
import { DEFAULT_SET_ID, getLatestSet } from './content/sets';
import App from './App';

// The pack opener, down to the stage it reports: a pack torn and opening, or back on the shelf.
const opener = vi.hoisted(() => ({ onBusyChange: undefined as undefined | ((busy: boolean) => void), onFocusChange: undefined as undefined | ((focus: boolean) => void) }));
vi.mock('./components/pack/PackOpener', () => ({
  default: (props: { onBusyChange: (busy: boolean) => void; onFocusChange: (focus: boolean) => void }) => {
    opener.onBusyChange = props.onBusyChange;
    opener.onFocusChange = props.onFocusChange;
    return null;
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no matchMedia or ResizeObserver; the app and the Sheet only use them for motion and layout.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  localStorage.clear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** A new player has nothing saved: no tabs or set picker, only the pack. A returning one has a pack saved. */
const mount = async (savedPack: boolean) => {
  if (savedPack) localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
  await act(async () => root.render(<App />));
};

const guideButton = () => [...document.querySelectorAll('main button')].find((b) => b.textContent?.trim() === 'Card guide') as HTMLButtonElement | undefined;
const dialog = () => document.querySelector('[role="dialog"]');

it('shows a new player no card guide link before their first pack is saved (#898)', async () => {
  await mount(false);
  expect(document.querySelector('nav')).toBeNull();
  expect(guideButton()).toBeUndefined();
});

it('offers the card guide once a pack is saved, and gives focus back when it closes', async () => {
  await mount(true);
  const button = guideButton()!;
  expect(button).toBeDefined();
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');

  button.focus();
  await act(async () => button.click());
  const sheet = dialog()!;
  expect(document.getElementById(sheet.getAttribute('aria-labelledby')!)?.textContent).toBe('Card guide');
  // The guide is the selected pack's: a new player's is the default set.
  expect(sheet.textContent).toContain(`Rarity, modifiers and scoring for ${getLatestSet(DEFAULT_SET_ID)!.name}`);

  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(button);
});

it('steps aside while a pack is torn and opening, and comes back once it is put away', async () => {
  await mount(true);
  expect(guideButton()).toBeDefined();
  await act(async () => opener.onFocusChange!(true));
  expect(guideButton()).toBeUndefined();
  await act(async () => opener.onBusyChange!(true));
  expect(guideButton()).toBeUndefined();
  // The reveal ends (no longer busy) but the summary is still up: still out of the way.
  await act(async () => opener.onBusyChange!(false));
  expect(guideButton()).toBeUndefined();
  await act(async () => opener.onFocusChange!(false));
  expect(guideButton()).toBeDefined();
});
