// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { trackInputModality } from './inputModality';

const modality = () => document.documentElement.dataset.input;
const key = (k: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
const press = (target: EventTarget = document.body) => target.dispatchEvent(new Event('pointerdown', { bubbles: true }));

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  delete document.documentElement.dataset.input;
});

describe('trackInputModality', () => {
  // A screen reader, switch or voice control can move focus with no key heard here: until a press, ring it.
  it('starts as keyboard, before any input', () => {
    stop = trackInputModality();
    expect(modality()).toBe('keyboard');
  });

  it('a pointer press switches to pointer', () => {
    stop = trackInputModality();
    press();
    expect(modality()).toBe('pointer');
  });

  it.each(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Escape'])('switches to keyboard on %j', (k) => {
    stop = trackInputModality();
    press();
    key(k);
    expect(modality()).toBe('keyboard');
  });

  // Space and Enter drive the game; they must not ring whatever the app focuses next.
  it.each(['Enter', ' '])('switches to press on %j', (k) => {
    stop = trackInputModality();
    expect(modality()).toBe('keyboard');
    key(k);
    expect(modality()).toBe('press');
    press();
    key(k);
    expect(modality()).toBe('press');
  });

  it('navigation keys bring the keyboard back after a press, and a pointer press ends it', () => {
    stop = trackInputModality();
    key(' ');
    key('Tab');
    expect(modality()).toBe('keyboard');
    key(' ');
    press();
    expect(modality()).toBe('pointer');
  });

  it.each(['Ctrl', 'Alt', 'Meta'])('ignores %s+Space', (name) => {
    stop = trackInputModality();
    press();
    key(' ', document.body, { [`${name.toLowerCase()}Key`]: true });
    expect(modality()).toBe('pointer');
  });

  it('counts Shift+Tab', () => {
    stop = trackInputModality();
    press();
    key('Tab', document.body, { shiftKey: true });
    expect(modality()).toBe('keyboard');
  });

  it('ignores bare modifiers and typed characters', () => {
    stop = trackInputModality();
    press();
    for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'a', 'CapsLock']) key(k);
    expect(modality()).toBe('pointer');
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Alt', { altKey: true }],
    ['Meta', { metaKey: true }],
  ] as const)('ignores %s chords on navigation keys', (_, init) => {
    stop = trackInputModality();
    press();
    for (const k of ['Tab', 'ArrowLeft', 'Home', 'PageDown', 'Enter']) key(k, document.body, init);
    expect(modality()).toBe('pointer');
  });

  it('a pointer press after keys switches back, and keys after it switch again', () => {
    stop = trackInputModality();
    key('Tab');
    press();
    expect(modality()).toBe('pointer');
    key('Tab');
    expect(modality()).toBe('keyboard');
    key('Shift');
    expect(modality()).toBe('keyboard');
  });

  it('hears events a handler stops from bubbling', () => {
    stop = trackInputModality();
    const button = document.body.appendChild(document.createElement('button'));
    button.addEventListener('keydown', (event) => event.stopPropagation());
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    press(button);
    expect(modality()).toBe('pointer');
    key('Tab', button);
    expect(modality()).toBe('keyboard');
    button.remove();
  });

  it('stops listening once stopped', () => {
    trackInputModality()();
    press();
    expect(modality()).toBe('keyboard');
  });
});
