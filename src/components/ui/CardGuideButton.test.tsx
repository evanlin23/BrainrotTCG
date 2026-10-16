// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getLatestSet } from '../../content/sets';
import CardGuideButton from './CardGuideButton';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver; the Sheet only uses it to track overflow.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const set = getLatestSet('right-now')!;
const button = () => container.querySelector('button')!;
const dialog = () => document.querySelector('[role="dialog"]');

it('is a labelled button that opens the guide for its set as a modal dialog', () => {
  act(() => root.render(<CardGuideButton set={set} />));
  expect(button().textContent?.trim()).toBe('Card guide');
  expect(button().className).toBe('card-guide-link');
  expect(button().getAttribute('aria-haspopup')).toBe('dialog');
  expect(dialog()).toBeNull();
  act(() => button().click());
  expect(dialog()!.getAttribute('aria-modal')).toBe('true');
  expect(dialog()!.textContent).toContain(`Rarity, modifiers and scoring for ${set.name}`);
});

it('closes with Escape or Close and hands focus back to the button', () => {
  act(() => root.render(<CardGuideButton set={set} className="btn btn--secondary" />));
  expect(button().className).toBe('btn btn--secondary');
  // As a button the icon keeps the link's 16px size, which `.btn svg` would otherwise override (#486).
  expect(button().querySelector('svg')!.getAttribute('class')).toContain('card-guide-icon');
  for (const close of [
    () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click(),
  ]) {
    button().focus();
    act(() => button().click());
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).not.toBe(button());
    act(close);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button());
  }
});
