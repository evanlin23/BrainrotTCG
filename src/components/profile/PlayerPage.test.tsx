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
let onClose: ReturnType<typeof vi.fn<() => void>>;
let onOpenGoals: ReturnType<typeof vi.fn<() => void>>;
let onOpenSave: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver; the page's Sheet only uses it to track overflow.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  localStorage.clear();
  localStorage.setItem(PLAYER_KEY, JSON.stringify(stored));
  setItem = vi.spyOn(Storage.prototype, 'setItem');
  onClose = vi.fn<() => void>();
  onOpenGoals = vi.fn<() => void>();
  onOpenSave = vi.fn<() => void>();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root.render(
    <PlayerPage level={1} settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onClose={onClose} onOpenGoals={onOpenGoals} onOpenSave={onOpenSave} />,
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
const failWrites = () => setItem.mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
const SAVE_FAILED = "Couldn't save your name in this browser. Try again.";
/** A pointer close: mousedown moves focus off the field (saving it) before the click lands. */
const closeBy = (target: 'Close' | 'the backdrop') => {
  const el = document.querySelector<HTMLElement>(target === 'Close' ? 'button[aria-label="Close"]' : '.sheet-backdrop')!;
  act(() => { if (target === 'Close') el.focus(); else input().blur(); });
  act(() => el.click());
};
const pressEscape = () => act(() => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
const playerWrites = () => setItem.mock.calls.filter(([key]) => key === PLAYER_KEY);
const statusNode = () => document.querySelector('.settings-group [role="status"]')!.firstChild;
/** A pointer press on one of the page's buttons: focus moves to it (blurring the field), then it clicks. */
const pressButton = (label: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!;
  act(() => el.focus());
  act(() => el.click());
};

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
    expect(status()).toBe('');
    expect(input().value).toBe('Original Player');
    expect(playerWrites()).toEqual([]);
  });

  it('keeps the current name for a blank one, without claiming a save', () => {
    type('   ');
    act(() => input().blur());
    // Leaving a blank field keeps the draft so the player can keep typing; nothing is written.
    expect(input().value).toBe('   ');
    expect(status()).toBe('');
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

  it('writes and announces a failed save once when a pointer press on Save name blurs the field first', () => {
    failWrites();
    type('Unsaved Name');
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === 'Save name')!;
    // A real pointer press: pointerdown, then focus moves (blurring the field), then a counted click.
    const pointerDown = () => act(() => save.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    const click = () => act(() => save.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    pointerDown();
    act(() => save.focus());
    expect(playerWrites()).toHaveLength(1);
    expect(status()).toBe(SAVE_FAILED);
    const announced = statusNode();
    click();
    // The click reused the blur's result rather than writing and remounting the live region text again.
    expect(playerWrites()).toHaveLength(1);
    expect(statusNode()).toBe(announced);
    // The next press has no blur of its own, so it is the retry the message asks for.
    pointerDown();
    click();
    expect(playerWrites()).toHaveLength(2);
    expect(statusNode()).not.toBe(announced);
    expect(status()).toBe(SAVE_FAILED);
  });
});

describe('the status line', () => {
  it('opens with an empty live region and shows the player ID outside it', () => {
    expect(status()).toBe('');
    expect(document.querySelector('.settings-group')!.textContent).toMatch(/Player ID #\w+/);
  });

  it('only changes for a new save result, not for typing or an unchanged save', () => {
    type('Typed Name');
    expect(status()).toBe('');
    clickSave();
    expect(status()).toBe('Display name saved.');
    // Saving the same name again writes nothing, so the live region keeps the same message.
    clickSave();
    expect(status()).toBe('Display name saved.');
    expect(playerWrites()).toHaveLength(1);
  });

  it('announces a repeated save failure again', () => {
    failWrites();
    type('New Name');
    clickSave();
    const shown = document.querySelector('.settings-group [role="status"]')!.firstChild;
    clickSave();
    expect(status()).toBe(SAVE_FAILED);
    // Same text, new node inside the live region, so screen readers hear the second failure too.
    expect(document.querySelector('.settings-group [role="status"]')!.firstChild).not.toBe(shown);
  });
});

describe('closing with an unsaved draft', () => {
  it('saves a changed name when Escape closes the sheet', () => {
    type('Escaped Name');
    pressEscape();
    expect(storedName()).toBe('Escaped Name');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes without writing when the draft is blank or unchanged', () => {
    type('   ');
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(playerWrites()).toEqual([]);
    expect(storedName()).toBe('Original Player');
  });

  it('stays open once with the draft when that save fails, then closes on the next Escape', () => {
    setItem.mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    type('Unsaved Name');
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(status()).toBe("Couldn't save your name in this browser. Try again.");
    expect(input().value).toBe('Unsaved Name');
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(storedName()).toBe('Original Player');
  });

  it.each(['Close', 'the backdrop'] as const)('stays open once when that save fails and %s blurred the field first', (target) => {
    failWrites();
    type('Unsaved Name');
    closeBy(target);
    expect(onClose).not.toHaveBeenCalled();
    expect(status()).toBe(SAVE_FAILED);
    expect(input().value).toBe('Unsaved Name');
    closeBy(target);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(storedName()).toBe('Original Player');
  });

  it('writes and announces a failed save once when a pointer close blurs the field first', () => {
    failWrites();
    type('Unsaved Name');
    const close = document.querySelector<HTMLElement>('button[aria-label="Close"]')!;
    act(() => close.focus());
    const announced = statusNode();
    expect(playerWrites()).toHaveLength(1);
    act(() => close.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(playerWrites()).toHaveLength(1);
    // The click reused the blur's result instead of remounting the live region text a second time.
    expect(statusNode()).toBe(announced);
    act(() => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(playerWrites()).toHaveLength(1);
  });

  it('stays open once more after the name is edited again', () => {
    failWrites();
    type('Unsaved Name');
    pressEscape();
    type('Edited Again');
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(input().value).toBe('Edited Again');
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('leaving for Goals or Save with an unsaved draft', () => {
  it.each([
    ['Goals & rewards', () => onOpenGoals],
    ['Save & restore', () => onOpenSave],
  ] as const)('%s saves a changed name and then opens', (label, opened) => {
    type('Saved First');
    pressButton(label);
    expect(storedName()).toBe('Saved First');
    expect(playerWrites()).toHaveLength(1);
    expect(opened()).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Goals & rewards', () => onOpenGoals],
    ['Save & restore', () => onOpenSave],
  ] as const)('%s keeps the draft and the error once when that save fails', (label, opened) => {
    failWrites();
    type('Unsaved Name');
    pressButton(label);
    expect(opened()).not.toHaveBeenCalled();
    expect(input().value).toBe('Unsaved Name');
    expect(status()).toBe(SAVE_FAILED);
    expect(playerWrites()).toHaveLength(1);
    pressButton(label);
    expect(opened()).toHaveBeenCalledTimes(1);
    expect(playerWrites()).toHaveLength(1);
  });
});

describe('while the level is unknown', () => {
  const rerender = (level: number | null) => act(() => root.render(
    <PlayerPage level={level} settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onClose={onClose} onOpenGoals={onOpenGoals} onOpenSave={onOpenSave} />,
  ));

  it('shows a loading note instead of the rewards, then the rewards once the level is known', () => {
    rerender(null);
    expect(document.querySelector('.rewards')).toBeNull();
    expect(document.body.textContent).toContain('Reading your saved packs… Your level and rewards will show once they\'re in.');
    expect(document.body.textContent).not.toMatch(/Level \d/);
    rerender(1);
    expect(document.querySelector('.rewards')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Reading your saved packs');
  });
});
