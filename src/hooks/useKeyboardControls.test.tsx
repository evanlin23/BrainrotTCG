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
