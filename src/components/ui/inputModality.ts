/**
 * Which kind of input the player last used, as `data-input` on <html>: "keyboard" after a key that
 * navigates (Tab, arrows, Home, End, Page Up, Page Down, Escape), "press" after Enter or Space, which
 * drive the game, and "pointer" after a mouse, pen or touch press. It starts as "keyboard". Ctrl, Alt
 * and Meta chords change nothing.
 *
 * The app moves focus by script as a pack opens (the next card, the result, a dialog). Browsers ring
 * script focus that no click put there, and on a phone a tap rarely does, so that ring reads as a
 * selection; so does the ring after Space or Enter has merely advanced the game. CSS drops the ring
 * on those targets after a pointer press or Space/Enter (base.css, #312), and navigation keys bring it
 * back. It starts as keyboard: a screen reader, switch or voice control can move focus with no key
 * heard here, while a touch or mouse player presses before the app moves focus for them.
 */
export type InputModality = 'keyboard' | 'press' | 'pointer';

/** Keys that navigate (ring on) or press (ring off). Bare modifiers, typed characters and shortcut chords leave the modality as it was. */
const KEYBOARD_KEYS = new Set([
  'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Escape',
]);
const PRESS_KEYS = new Set(['Enter', ' ']);

const set = (root: HTMLElement, modality: InputModality) => {
  if (root.dataset.input !== modality) root.dataset.input = modality;
};

/** Starts tracking; returns a function that stops it. Listens in the capture phase, ahead of handlers that stop propagation. */
export function trackInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  set(root, 'keyboard');
  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (KEYBOARD_KEYS.has(event.key)) set(root, 'keyboard');
    else if (PRESS_KEYS.has(event.key)) set(root, 'press');
  };
  const onPointer = () => set(root, 'pointer');
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', onPointer, true);
  return () => {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('pointerdown', onPointer, true);
  };
}
