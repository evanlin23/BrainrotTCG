// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import PlayerSection from './PlayerSection';

const PLAYER_KEY = 'brainrot-player-v1';
const stored = { secretKey: 'cd'.repeat(32), name: 'Original Player', nextNonce: 4, createdAt: 1 };
const storedName = () => JSON.parse(localStorage.getItem(PLAYER_KEY)!).name as string;

let root: Root;
let container: HTMLElement;
let setItem: MockInstance<Storage['setItem']>;
let canSave: ReturnType<typeof vi.fn<() => boolean>>;
let onSaveFailed: ReturnType<typeof vi.fn<() => void>>;
let onRenamed: ReturnType<typeof vi.fn<(player: { name: string }) => void>>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  localStorage.clear();
  localStorage.setItem(PLAYER_KEY, JSON.stringify(stored));
  setItem = vi.spyOn(Storage.prototype, 'setItem');
  canSave = vi.fn(() => true);
  onSaveFailed = vi.fn<() => void>();
  onRenamed = vi.fn();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root.render(<PlayerSection onRenamed={onRenamed} canSave={canSave} onSaveFailed={onSaveFailed} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === name);
const input = () => document.querySelector<HTMLInputElement>('input[autocomplete="nickname"]')!;
const status = () => document.querySelector<HTMLElement>('#player [role="status"]')!.textContent;
const heading = () => document.querySelector('#player h2')!.textContent;
const edit = () => act(() => button('Edit name')!.click());
/** Open the field (if it isn't) and type into it. */
const type = (value: string) => {
  if (!document.querySelector('input[autocomplete="nickname"]')) edit();
  act(() => {
    input().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const clickSave = () => {
  if (!document.querySelector('input[autocomplete="nickname"]')) edit();
  act(() => button('Save')!.click());
};
const failWrites = () => setItem.mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
const SAVE_FAILED = "Couldn't save your name in this browser. Try again.";
const SAVE_STALE = "Your name wasn't saved: this save changed in another tab. Reload to continue with that save.";
/** Another tab stores a record (a different player, or this one renamed) without this page knowing. */
const otherTabStores = (record: object) => {
  localStorage.setItem(PLAYER_KEY, JSON.stringify(record));
  setItem.mockClear();
};
const theirs = { secretKey: 'ef'.repeat(32), name: 'Their Player', nextNonce: 9, createdAt: 2 };
const playerWrites = () => setItem.mock.calls.filter(([key]) => key === PLAYER_KEY);
const statusNode = () => document.querySelector('#player [role="status"]')!.firstChild;
/** Leaving the Profile page (a tab, Back or its close button) unmounts the section. */
const leave = () => act(() => root.render(<p>Another page</p>));

describe('the identity header', () => {
  it('shows the name and Player ID once, with the field closed and an empty live region', () => {
    expect(heading()).toBe('Original Player');
    expect(document.querySelector('#player')!.textContent).toMatch(/Player ID #\w+/);
    expect(document.querySelectorAll('#player h2')).toHaveLength(1);
    expect(document.querySelector('input')).toBeNull();
    expect(status()).toBe('');
  });

  it('opens the field in place, labelled and focused', () => {
    edit();
    expect(button('Edit name')).toBeUndefined();
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe('Original Player');
    expect(input().labels![0].textContent).toBe('Name shown on shared pulls');
    expect(status()).toBe('');
  });

  it('saves with the form (Enter or Save), closes, and returns focus to Edit name', () => {
    type('Saved Name');
    // Enter in the field submits its form, as the Save button does.
    act(() => input().form!.requestSubmit());
    expect(storedName()).toBe('Saved Name');
    expect(heading()).toBe('Saved Name');
    expect(status()).toBe('Display name saved.');
    expect(onRenamed).toHaveBeenCalledWith(expect.objectContaining({ name: 'Saved Name' }));
    expect(document.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(button('Edit name'));
  });

  it('cancels without writing, puts the name back and returns focus to Edit name', () => {
    type('Not Kept');
    act(() => button('Cancel')!.click());
    expect(document.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(button('Edit name'));
    expect(playerWrites()).toEqual([]);
    edit();
    expect(input().value).toBe('Original Player');
  });

  it('cancels on Escape without the key reaching the page behind it', () => {
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    type('Not Kept');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { input().dispatchEvent(escape); });
    document.removeEventListener('keydown', behind);
    expect(escape.defaultPrevented).toBe(true);
    expect(behind).not.toHaveBeenCalled();
    expect(document.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(button('Edit name'));
    expect(playerWrites()).toEqual([]);
    expect(heading()).toBe('Original Player');
  });

  it('has no links to the other pages', () => {
    expect(document.querySelector('.personal-nav')).toBeNull();
    expect([...document.querySelectorAll('button')].map((el) => el.textContent)).not.toContain('Achievements');
  });
});

describe('saving the display name', () => {
  it.each([
    ['quota', new DOMException('Quota exceeded', 'QuotaExceededError')],
    ['security', new DOMException('Storage blocked', 'SecurityError')],
  ])('says the name was not saved when this browser refuses the write (%s)', (_label, error) => {
    setItem.mockImplementation(() => { throw error; });
    type('New Name');
    clickSave();
    expect(status()).toBe(SAVE_FAILED);
    expect(document.body.textContent).not.toContain('Display name saved.');
    expect(storedName()).toBe('Original Player');
    expect(heading()).toBe('Original Player');
    // The field stays open with the draft so the player can retry.
    expect(input().value).toBe('New Name');
  });

  it('does not claim a save for an unchanged name, and just closes', () => {
    type(' Original  Player ');
    clickSave();
    expect(status()).toBe('');
    expect(document.querySelector('input')).toBeNull();
    expect(playerWrites()).toEqual([]);
  });

  it('keeps the current name for a blank one, without claiming a save', () => {
    type('   ');
    clickSave();
    expect(status()).toBe("A name can't be blank, so your current name stays.");
    expect(input().value).toBe('Original Player');
    expect(playerWrites()).toEqual([]);
    expect(storedName()).toBe('Original Player');
  });

  it('refuses a name that is not allowed, keeping the current one and the draft to edit', () => {
    type('xXfuckXx');
    clickSave();
    expect(status()).toBe("That name isn't allowed here. Try another one; your current name stays.");
    expect(input().value).toBe('xXfuckXx');
    expect(heading()).toBe('Original Player');
    expect(playerWrites()).toEqual([]);
    expect(storedName()).toBe('Original Player');
    expect(onRenamed).not.toHaveBeenCalled();
    // Leaving with it doesn't write it either, or report a failed save.
    leave();
    expect(playerWrites()).toEqual([]);
    expect(onSaveFailed).not.toHaveBeenCalled();
  });
});

describe('Unicode names and the length limit', () => {
  const composed = 'Café Explorer Club Squad';
  const decomposed = 'Café Explorer Club Squad';

  it('has the 25-code-point decomposed form of a 24-character name', () => {
    expect(Array.from(decomposed)).toHaveLength(25);
    expect(Array.from(composed)).toHaveLength(24);
  });

  it.each([['decomposed', decomposed], ['composed', composed]])('keeps the whole %s name through Save', (_label, value) => {
    type(value);
    expect(input().value).toBe(composed);
    clickSave();
    expect(storedName()).toBe(composed);
    expect(heading()).toBe(composed);
  });

  it.each([['decomposed', decomposed], ['composed', composed]])('keeps the whole %s name when leaving the page', (_label, value) => {
    type(value);
    leave();
    expect(storedName()).toBe(composed);
  });

  it('still caps a longer name at 24 code points, astral emoji counting once', () => {
    type('\u{1F9E0}'.repeat(30));
    expect(Array.from(input().value)).toHaveLength(24);
    clickSave();
    expect(storedName()).toBe('\u{1F9E0}'.repeat(24));
  });

  it('keeps whitespace as typed while editing and cleans it only on save', () => {
    type('Two  words ');
    expect(input().value).toBe('Two  words ');
    clickSave();
    expect(storedName()).toBe('Two words');
  });

  it('leaves an in-progress composition alone and normalizes when it ends', () => {
    edit();
    act(() => {
      input().focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), decomposed);
      input().dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    expect(input().value).toBe(decomposed);
    act(() => { input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    expect(input().value).toBe(composed);
  });

  it('writes nothing on Cancel or Escape', () => {
    type(decomposed);
    act(() => button('Cancel')!.click());
    edit();
    type(decomposed);
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(playerWrites()).toEqual([]);
    expect(storedName()).toBe('Original Player');
  });
});

describe('the status line', () => {
  it('only changes for a new save result, not for typing or an unchanged save', () => {
    type('Typed Name');
    expect(status()).toBe('');
    clickSave();
    expect(status()).toBe('Display name saved.');
    // Saving the same name again writes nothing, so the live region keeps the same message.
    expect(document.activeElement).toBe(button('Edit name'));
    clickSave();
    expect(status()).toBe('Display name saved.');
    expect(playerWrites()).toHaveLength(1);
  });

  it('announces a repeated save failure again', () => {
    failWrites();
    type('New Name');
    clickSave();
    const shown = statusNode();
    clickSave();
    expect(status()).toBe(SAVE_FAILED);
    // Same text, new node inside the live region, so screen readers hear the second failure too.
    expect(statusNode()).not.toBe(shown);
  });

  it.each([
    ['another player is stored now', () => otherTabStores(theirs), 'Their Player'],
    ['this tab may no longer write its save', () => canSave.mockReturnValue(false), 'Original Player'],
  ])('writes nothing and says why when %s', (_label, change, kept) => {
    type('My New Name');
    change();
    clickSave();
    expect(status()).toBe(SAVE_STALE);
    expect(playerWrites()).toEqual([]);
    expect(storedName()).toBe(kept);
    expect(input().value).toBe('My New Name');
  });
});


describe('leaving the page with an unsaved draft', () => {
  it('saves a changed name', () => {
    type('Left Name');
    leave();
    expect(storedName()).toBe('Left Name');
    expect(playerWrites()).toHaveLength(1);
    expect(onSaveFailed).not.toHaveBeenCalled();
  });

  it('never writes a draft that was not edited, so a rename from another tab stays', () => {
    otherTabStores({ ...stored, name: 'Renamed Elsewhere' });
    leave();
    expect(playerWrites()).toEqual([]);
    expect(storedName()).toBe('Renamed Elsewhere');
  });

  it('never writes a draft edited back to the loaded name', () => {
    type('Something Else');
    type(' Original  Player ');
    otherTabStores({ ...stored, name: 'Renamed Elsewhere' });
    leave();
    expect(playerWrites()).toEqual([]);
    expect(storedName()).toBe('Renamed Elsewhere');
  });

  it('writes nothing once another player is stored, so that player keeps its name', () => {
    type('Left Name');
    otherTabStores(theirs);
    leave();
    expect(playerWrites()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!)).toEqual(theirs);
    expect(onSaveFailed).not.toHaveBeenCalled();
  });

  it('writes nothing once this tab may no longer write its save', () => {
    type('Left Name');
    canSave.mockReturnValue(false);
    leave();
    expect(canSave).toHaveBeenCalled();
    expect(playerWrites()).toEqual([]);
    expect(storedName()).toBe('Original Player');
  });

  it('reports a name this browser refused to store on the way out', () => {
    failWrites();
    type('Left Name');
    leave();
    expect(playerWrites()).toHaveLength(1);
    expect(onSaveFailed).toHaveBeenCalledTimes(1);
    expect(storedName()).toBe('Original Player');
  });

  it('writes nothing for a blank or unchanged draft', () => {
    type('   ');
    leave();
    expect(playerWrites()).toEqual([]);
    expect(storedName()).toBe('Original Player');
  });

  it('does not write again a draft whose save just failed, but still reports it on the way out', () => {
    failWrites();
    type('Unsaved Name');
    clickSave();
    expect(status()).toBe(SAVE_FAILED);
    expect(playerWrites()).toHaveLength(1);
    expect(onSaveFailed).not.toHaveBeenCalled();
    // A mouse click on a tab, Back or Close leaves without focusing the field again.
    leave();
    expect(playerWrites()).toHaveLength(1);
    expect(onSaveFailed).toHaveBeenCalledTimes(1);
    expect(storedName()).toBe('Original Player');
  });

  it('does not report a draft refused as stale on the way out, which already shows its banner', () => {
    canSave.mockReturnValue(false);
    type('Unsaved Name');
    clickSave();
    expect(status()).toBe(SAVE_STALE);
    leave();
    expect(playerWrites()).toEqual([]);
    expect(onSaveFailed).not.toHaveBeenCalled();
    expect(storedName()).toBe('Original Player');
  });

  it('does not write or report a draft the stored player refused as stale on the way out', () => {
    type('Unsaved Name');
    // Another tab stores a different player, so the rename itself (not canSave) finds the save stale.
    otherTabStores(theirs);
    clickSave();
    expect(canSave).toHaveBeenCalled();
    expect(status()).toBe(SAVE_STALE);
    expect(playerWrites()).toEqual([]);
    leave();
    expect(playerWrites()).toEqual([]);
    expect(onSaveFailed).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!)).toEqual(theirs);
  });

  it('tries again once the failed draft is edited', () => {
    failWrites();
    type('Unsaved Name');
    clickSave();
    type('Edited Again');
    setItem.mockRestore();
    leave();
    expect(storedName()).toBe('Edited Again');
  });
});
