// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DEFAULT_SETTINGS } from '../../utils/settings';
import PlayerPage from './PlayerPage';

const PLAYER_KEY = 'brainrot-player-v1';
const stored = { secretKey: 'cd'.repeat(32), name: 'Original Player', nextNonce: 4, createdAt: 1 };
const storedName = () => JSON.parse(localStorage.getItem(PLAYER_KEY)!).name as string;

let root: Root;
let container: HTMLElement;
let setItem: MockInstance<Storage['setItem']>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver; the page's Sheet only uses it to track overflow.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  localStorage.clear();
  localStorage.setItem(PLAYER_KEY, JSON.stringify(stored));
  setItem = vi.spyOn(Storage.prototype, 'setItem');
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root.render(
    <PlayerPage level={1} settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onClose={() => {}} onOpenGoals={() => {}} onOpenSave={() => {}} />,
  ));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const input = () => document.querySelector<HTMLInputElement>('input[autocomplete="nickname"]')!;
const status = () => document.querySelector<HTMLElement>('.settings-group [role="status"]')!.textContent;
const type = (value: string) => act(() => {
  input().focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
  input().dispatchEvent(new Event('input', { bubbles: true }));
});
const clickSave = () => act(() => {
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === 'Save name')!.click();
});
const playerWrites = () => setItem.mock.calls.filter(([key]) => key === PLAYER_KEY);

describe('saving the display name', () => {
  it.each([
    ['quota', new DOMException('Quota exceeded', 'QuotaExceededError')],
    ['security', new DOMException('Storage blocked', 'SecurityError')],
  ])('says the name was not saved when this browser refuses the write (%s)', (_label, error) => {
    setItem.mockImplementation(() => { throw error; });
    type('New Name');
    clickSave();
    expect(status()).toBe("Couldn't save your name in this browser. Try again.");
    expect(document.body.textContent).not.toContain('Display name saved.');
    expect(storedName()).toBe('Original Player');
    // The draft stays so the player can retry.
    expect(input().value).toBe('New Name');
  });

  it('does not claim a save for an unchanged name', () => {
    clickSave();
    type(' Original  Player ');
    clickSave();
    expect(status()).toMatch(/^Player ID #/);
    expect(input().value).toBe('Original Player');
    expect(playerWrites()).toEqual([]);
  });

  it('keeps the current name for a blank one, without claiming a save', () => {
    type('   ');
    act(() => input().blur());
    // Leaving a blank field keeps the draft so the player can keep typing; nothing is written.
    expect(input().value).toBe('   ');
    expect(status()).toMatch(/^Player ID #/);
    clickSave();
    expect(status()).toBe("A name can't be blank, so your current name stays.");
    expect(input().value).toBe('Original Player');
    expect(playerWrites()).toEqual([]);
    expect(storedName()).toBe('Original Player');
  });

  it('saves a valid changed name when the field loses focus, and only once', () => {
    type('Blurred Name');
    act(() => input().blur());
    expect(storedName()).toBe('Blurred Name');
    expect(status()).toBe('Display name saved.');
    // Clicking Save right after (the click is what blurred the field) writes nothing more and keeps the message.
    clickSave();
    expect(status()).toBe('Display name saved.');
    expect(playerWrites()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!)).toEqual({ ...stored, name: 'Blurred Name' });
  });
});
