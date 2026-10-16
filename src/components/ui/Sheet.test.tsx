// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sheet from './Sheet';

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

const open = (bare: boolean) => {
  const onClose = vi.fn();
  act(() => root.render(
    <Sheet title="A card" onClose={onClose} bare={bare}>
      <div className="content"><p className="flavor">Some flavor text</p><button type="button">Share card</button></div>
    </Sheet>,
  ));
  const at = (selector: string) => document.querySelector<HTMLElement>(selector)!;
  // jsdom has no PointerEvent; React only reads the type, and a MouseEvent carries the main button.
  const fire = (selector: string, type: string, button = 0) => act(() => { at(selector).dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button })); });
  /** A click with no pointer behind it: a screen reader's double-tap, a script, a keyboard. */
  const click = (selector: string) => act(() => at(selector).click());
  /**
   * A main-button press that starts on one element and ends on another; the click lands where the
   * browser puts it, on the common ancestor (`clickOn`, the end by default).
   */
  const press = (from: string, to = from, clickOn = to) => {
    fire(from, 'pointerdown');
    fire(to, 'pointerup');
    click(clickOn);
  };
  return { onClose, click, fire, press };
};

describe('closing a sheet from outside its content (#182)', () => {
  it('closes a bare sheet from its backdrop and from a press on its own empty space, which is all a phone shows around the card', () => {
    const { onClose, click, press } = open(true);
    click('.sheet-backdrop');
    press('.sheet-body');
    press('.sheet');
    press('.sheet-body', '.sheet');
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("keeps a bare sheet open for presses on its content and buttons, the card's included", () => {
    const { onClose, click, press } = open(true);
    press('.content');
    press('.flavor');
    press('.content button');
    press('.sheet-heading');
    expect(onClose).not.toHaveBeenCalled();
    click('.sheet-close');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a bare sheet open when a drag selecting the card's text ends on its empty space, or starts there and ends on the card", () => {
    const { onClose, press } = open(true);
    // The browser fires the click on the common ancestor, which is the empty body or panel itself.
    press('.content', '.sheet-body');
    press('.flavor', '.sheet-body');
    press('.flavor', '.sheet', '.sheet');
    press('.sheet-body', '.content', '.sheet-body');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps a bare sheet open for a click no pointer pressed there: a screen reader double-tap on the focused dialog, a script', () => {
    const { onClose, click, fire, press } = open(true);
    click('.sheet');
    click('.sheet-body');
    // A cancelled press (the page scrolled instead) and a non-main button don't count either.
    fire('.sheet-body', 'pointerdown');
    fire('.sheet-body', 'pointercancel');
    click('.sheet-body');
    fire('.sheet-body', 'pointerdown', 2);
    fire('.sheet-body', 'pointerup');
    click('.sheet-body');
    expect(onClose).not.toHaveBeenCalled();
    // A press is used once: the click after it doesn't arm the next one.
    press('.sheet-body');
    click('.sheet-body');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes a panel sheet only from its backdrop: its body is the panel's own surface", () => {
    const { onClose, click, press } = open(false);
    press('.sheet-body');
    press('.sheet');
    press('.content');
    expect(onClose).not.toHaveBeenCalled();
    click('.sheet-backdrop');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
