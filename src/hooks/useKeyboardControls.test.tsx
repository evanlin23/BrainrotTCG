// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardControls } from './useKeyboardControls';

type Options = Parameters<typeof useKeyboardControls>[0];
const Probe = (options: Options) => {
  useKeyboardControls(options);
  return null;
};

let root: Root | null = null;
let onLeave = vi.fn();
const render = (overrides: Partial<Options> = {}) => act(() => {
  root ??= createRoot(document.createElement('div'));
  root.render(
    <Probe
      isOpening
      showSummary={false}
      disabled={false}
      onCloseSummary={() => {}}
      onOpenPack={() => {}}
      handleInteractionRef={{ current: () => {} }}
      inPack
      onLeave={onLeave}
      {...overrides}
    />,
  );
});
const escape = (target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const add = <T extends HTMLElement>(element: T) => document.body.appendChild(element);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onLeave = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Escape in a pack', () => {
  it('leaves the reveal once, as the pack\'s Back to packs button does', () => {
    render();
    const event = escape();
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    escape(document.body, { repeat: true });
    expect(onLeave, 'a held Escape closed again').toHaveBeenCalledTimes(1);
  });

  it('does nothing without a pack on screen, or while the pack is disabled', () => {
    for (const state of [{ inPack: false, isOpening: false }, { inPack: undefined }, { disabled: true }, { onLeave: undefined }]) {
      render(state);
      escape();
    }
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('leaves from every stage: the torn pack, the reveal and the summary', () => {
    for (const state of [{ isOpening: false }, {}, { showSummary: true }]) {
      render(state);
      escape();
    }
    expect(onLeave).toHaveBeenCalledTimes(3);
  });

  it('leaves Escape to an open dialog above the reveal', () => {
    render();
    const dialog = add(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const inside = dialog.appendChild(document.createElement('button'));
    escape(inside);
    escape();
    expect(onLeave).not.toHaveBeenCalled();
    dialog.remove();
    escape();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to a text field that has focus, and to anything that already handled it', () => {
    render();
    for (const field of [document.createElement('input'), document.createElement('textarea'), document.createElement('select')]) {
      add(field);
      field.focus();
      escape(field);
    }
    // contenteditable="" is an editable field too, as is any value but "false", down to the text inside it.
    for (const value of ['', 'true', 'plaintext-only']) {
      const field = add(document.createElement('div'));
      field.setAttribute('contenteditable', value);
      escape(field);
      escape(field.appendChild(document.createElement('span')));
    }
    const handled = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => { document.body.dispatchEvent(handled); });
    expect(onLeave).not.toHaveBeenCalled();

    // contenteditable="false" is not a field: Escape there still closes the reveal.
    const notEditable = add(document.createElement('div'));
    notEditable.setAttribute('contenteditable', 'false');
    escape(notEditable);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

/** The sealed pack: the one control whose focus lets Space or Enter open it (PackCuttingUI). */
const sealedPack = () => {
  const pack = add(document.createElement('div'));
  pack.setAttribute('data-pack-open', 'true');
  pack.tabIndex = 0;
  return pack;
};
const pressOn = (target: HTMLElement, code: string, init: KeyboardEventInit = {}) => {
  const key = code === 'Space' ? ' ' : code === 'Escape' ? 'Escape' : 'Enter';
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  act(() => { target.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true })); });
  return event;
};

describe('opening a sealed pack', () => {
  it('opens it with Space or Enter only while focus is on the pack', () => {
    const onOpenPack = vi.fn();
    render({ isOpening: false, onOpenPack });
    const pack = sealedPack();
    for (const code of ['Space', 'Enter', 'NumpadEnter']) {
      expect(pressOn(pack, code).defaultPrevented, code).toBe(true);
    }
    expect(onOpenPack).toHaveBeenCalledTimes(3);
  });

  it('leaves the keys to the page anywhere else, so typing or pressing keys never tears a pack', () => {
    const onOpenPack = vi.fn();
    render({ isOpening: false, onOpenPack });
    sealedPack();
    const elsewhere = add(document.createElement('div'));
    elsewhere.tabIndex = 0;
    for (const target of [document.body, elsewhere, add(document.createElement('main'))]) {
      for (const code of ['Space', 'Enter', 'NumpadEnter']) {
        expect(pressOn(target, code).defaultPrevented, `${code} on ${target.tagName}`).toBe(false);
      }
    }
    expect(onOpenPack).not.toHaveBeenCalled();
  });

  it('does not open from the pack when it is disabled', () => {
    const onOpenPack = vi.fn();
    render({ isOpening: false, disabled: true, onOpenPack });
    pressOn(sealedPack(), 'Space');
    expect(onOpenPack).not.toHaveBeenCalled();
  });
});

describe('modifier keys', () => {
  const press = (code: string, init: KeyboardEventInit = {}) => pressOn(pack, code, init);
  let pack: HTMLElement;
  beforeEach(() => {
    pack = sealedPack();
  });
  const modifiers: KeyboardEventInit[] = [{ ctrlKey: true }, { metaKey: true }, { altKey: true }];

  it('never opens, flips, closes or leaves a pack with Ctrl, Cmd or Alt held', () => {
    const onOpenPack = vi.fn();
    const onCloseSummary = vi.fn();
    const interact = vi.fn();
    for (const state of [{ isOpening: false }, { isOpening: true }, { showSummary: true }]) {
      render({ ...state, onOpenPack, onCloseSummary, handleInteractionRef: { current: interact } });
      for (const init of modifiers) {
        for (const code of ['Space', 'Enter', 'NumpadEnter', 'Escape']) {
          expect(press(code, init).defaultPrevented, `${code} with ${Object.keys(init)[0]}`).toBe(false);
        }
      }
    }
    expect(onOpenPack).not.toHaveBeenCalled();
    expect(interact).not.toHaveBeenCalled();
    expect(onCloseSummary).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();

    // The same keys without a modifier still work.
    render({ isOpening: false, onOpenPack });
    press('Space');
    expect(onOpenPack).toHaveBeenCalledTimes(1);
    render({ isOpening: true, handleInteractionRef: { current: interact } });
    press('Enter');
    expect(interact).toHaveBeenCalledTimes(1);
    press('Escape');
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe('a held Space', () => {
  const space = (type: 'keydown' | 'keyup', init: KeyboardEventInit = {}) => act(() => {
    document.body.dispatchEvent(new KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true, ...init }));
  });
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does one thing when pressed a moment, and repeats only once held past it', () => {
    const interact = vi.fn();
    render({ handleInteractionRef: { current: interact } });
    // A press held a little longer than the repeat rate flips the card and stops there.
    space('keydown');
    wait(390);
    space('keyup');
    wait(1000);
    expect(interact, 'a press held under the delay did more than one thing').toHaveBeenCalledTimes(1);

    // Held on, it moves on a card every 150ms after the delay, until it's let go.
    space('keydown');
    wait(399);
    expect(interact).toHaveBeenCalledTimes(2);
    wait(1);
    expect(interact).toHaveBeenCalledTimes(3);
    wait(300);
    expect(interact).toHaveBeenCalledTimes(5);
    space('keyup');
    wait(1000);
    expect(interact).toHaveBeenCalledTimes(5);
  });

  it('stops for the summary, even before it repeats', () => {
    const interact = vi.fn();
    render({ handleInteractionRef: { current: interact } });
    space('keydown');
    render({ handleInteractionRef: { current: interact }, showSummary: true });
    wait(1000);
    expect(interact).toHaveBeenCalledTimes(1);
  });

  it('stops when the window loses focus before it repeats, as its keyup never comes', () => {
    const interact = vi.fn();
    render({ handleInteractionRef: { current: interact } });
    space('keydown');
    wait(200);
    act(() => { window.dispatchEvent(new Event('blur')); });
    wait(1000);
    expect(interact).toHaveBeenCalledTimes(1);
  });

  it('stops when the pack goes away before it repeats', () => {
    const interact = vi.fn();
    render({ handleInteractionRef: { current: interact } });
    space('keydown');
    wait(200);
    act(() => root?.unmount());
    root = null;
    wait(1000);
    expect(interact).toHaveBeenCalledTimes(1);
  });

  it('runs one chain however many times Space goes down while held', () => {
    const interact = vi.fn();
    render({ handleInteractionRef: { current: interact } });
    space('keydown');
    wait(100);
    // A second press without a keyup between (another keyboard, or a lost keyup) neither acts nor restarts the delay.
    space('keydown');
    expect(interact).toHaveBeenCalledTimes(1);
    wait(300);
    expect(interact).toHaveBeenCalledTimes(2);
    // The system's own key repeat adds nothing either.
    for (let n = 0; n < 5; n++) space('keydown', { repeat: true });
    wait(150);
    expect(interact).toHaveBeenCalledTimes(3);
    space('keyup');
    wait(1000);
    expect(interact).toHaveBeenCalledTimes(3);

    // Nor does it start a chain once the hold has stopped: only a fresh press does.
    space('keydown', { repeat: true });
    wait(1000);
    expect(interact).toHaveBeenCalledTimes(3);
  });

  it('stops for a sheet opened over the pack, or the pack turning disabled', () => {
    const interact = vi.fn();
    render({ handleInteractionRef: { current: interact } });
    space('keydown');
    wait(400);
    expect(interact).toHaveBeenCalledTimes(2);
    const dialog = add(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    wait(1000);
    // And it stays stopped once the sheet closes, until Space is pressed again.
    dialog.remove();
    wait(1000);
    expect(interact).toHaveBeenCalledTimes(2);
    space('keyup');

    space('keydown');
    wait(400);
    expect(interact).toHaveBeenCalledTimes(4);
    render({ handleInteractionRef: { current: interact }, disabled: true });
    wait(1000);
    expect(interact).toHaveBeenCalledTimes(4);
  });
});

describe('Space and Enter on a focused button (#312)', () => {
  const key = (target: HTMLElement, code: 'Space' | 'Enter') => {
    const event = new KeyboardEvent('keydown', { key: code === 'Space' ? ' ' : 'Enter', code, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(event); });
    act(() => { target.dispatchEvent(new KeyboardEvent('keyup', { key: event.key, code, bubbles: true })); });
    return event;
  };

  it('leaves them to an ordinary button, such as Open pack, which they already press', () => {
    const onOpenPack = vi.fn();
    const interact = vi.fn();
    render({ isOpening: false, inPack: false, onOpenPack, handleInteractionRef: { current: interact } });
    const button = add(document.createElement('button'));
    for (const code of ['Space', 'Enter'] as const) expect(key(button, code).defaultPrevented).toBe(false);
    expect(onOpenPack).not.toHaveBeenCalled();
    expect(interact).not.toHaveBeenCalled();
  });

  it('handles them on a reveal card, a button that opts in, so a held Space keeps moving on', () => {
    const interact = vi.fn();
    render({ handleInteractionRef: { current: interact } });
    const card = add(document.createElement('button'));
    card.setAttribute('data-pack-keys', '');
    for (const code of ['Space', 'Enter'] as const) expect(key(card, code).defaultPrevented).toBe(true);
    expect(interact).toHaveBeenCalledTimes(2);
  });
});

describe('pack summary settle guard (#972, #1109 Item 5)', () => {
  const press = (code: 'Space' | 'Enter') => {
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: code === 'Space' ? ' ' : 'Enter', code, bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new KeyboardEvent('keyup', { key: code === 'Space' ? ' ' : 'Enter', code, bubbles: true }));
    });
  };

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ignores Space and Enter while the summary is settling, then closes it once settled', () => {
    const onCloseSummary = vi.fn();
    render({ isOpening: true, showSummary: false, onCloseSummary });

    // Transition to summary
    render({ isOpening: true, showSummary: true, onCloseSummary });

    // Trailing keypress immediately as summary appears is ignored
    press('Space');
    expect(onCloseSummary).not.toHaveBeenCalled();

    // Keypress mid-settling (200ms) is still ignored
    act(() => { vi.advanceTimersByTime(200); });
    press('Enter');
    expect(onCloseSummary).not.toHaveBeenCalled();

    // After 400ms settle delay, Space or Enter closes the summary
    act(() => { vi.advanceTimersByTime(200); });
    press('Space');
    expect(onCloseSummary).toHaveBeenCalledTimes(1);

    press('Enter');
    expect(onCloseSummary).toHaveBeenCalledTimes(2);
  });
});
