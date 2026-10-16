// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DEFAULT_SETTINGS } from '../../utils/settings';
import PlayerSection from './PlayerSection';

const PLAYER_KEY = 'brainrot-player-v1';
const stored = { secretKey: 'cd'.repeat(32), name: 'Original Player', nextNonce: 4, createdAt: 1 };
const storedName = () => JSON.parse(localStorage.getItem(PLAYER_KEY)!).name as string;

let root: Root;
let container: HTMLElement;
let setItem: MockInstance<Storage['setItem']>;
let onOpenSave: ReturnType<typeof vi.fn<() => void>>;
let canSave: ReturnType<typeof vi.fn<() => boolean>>;
let onSaveFailed: ReturnType<typeof vi.fn<() => void>>;
const section = (level: number | null) => (
  <PlayerSection level={level} settings={DEFAULT_SETTINGS} onSettingsChange={() => {}} onOpenSave={onOpenSave}
    canSave={canSave} onSaveFailed={onSaveFailed} />
);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  localStorage.clear();
  localStorage.setItem(PLAYER_KEY, JSON.stringify(stored));
  setItem = vi.spyOn(Storage.prototype, 'setItem');
  onOpenSave = vi.fn<() => void>();
  canSave = vi.fn(() => true);
  onSaveFailed = vi.fn<() => void>();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root.render(section(1)));
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
const SAVE_STALE = "Your name wasn't saved: this save changed in another tab. Reload to continue with that save.";
/** Another tab stores a record (a different player, or this one renamed) without this page knowing. */
const otherTabStores = (record: object) => {
  localStorage.setItem(PLAYER_KEY, JSON.stringify(record));
  setItem.mockClear();
};
const theirs = { secretKey: 'ef'.repeat(32), name: 'Their Player', nextNonce: 9, createdAt: 2 };
const playerWrites = () => setItem.mock.calls.filter(([key]) => key === PLAYER_KEY);
const statusNode = () => document.querySelector('.settings-group [role="status"]')!.firstChild;
/** Leaving the Profile page (a tab, Back or its close button) unmounts the section. */
const leave = () => act(() => root.render(<p>Another page</p>));

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
    act(() => input().blur());
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
    act(() => input().blur());
    expect(status()).toBe(SAVE_STALE);
    leave();
    expect(playerWrites()).toEqual([]);
    expect(onSaveFailed).not.toHaveBeenCalled();
    expect(storedName()).toBe('Original Player');
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

describe('the save note', () => {
  it('links to Settings, Save & backup', () => {
    const link = [...document.querySelectorAll<HTMLButtonElement>('.share-note button')].find((el) => el.textContent === 'Save & backup')!;
    act(() => link.click());
    expect(onOpenSave).toHaveBeenCalledTimes(1);
  });

  it('has no links to the other pages', () => {
    expect(document.querySelector('.personal-nav')).toBeNull();
    expect([...document.querySelectorAll('button')].map((el) => el.textContent)).not.toContain('Achievements');
  });
});

describe('while the level is unknown', () => {
  const rerender = (level: number | null) => act(() => root.render(section(level)));

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
