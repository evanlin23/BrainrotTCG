/**
 * Which kind of input the player last used, as `data-input` on <html>: "keyboard" after a key that
 * moves or presses (Tab, arrows, Home, End, Page Up, Page Down, Enter, Space, Escape, with no Ctrl,
 * Alt or Meta), "pointer" after a mouse, pen or touch press, and "keyboard" until either happens.
 *
 * The app moves focus by script as a pack opens (the next card, the result, a dialog). Browsers ring
 * script focus that no click put there, and on a phone a tap rarely does, so that ring reads as a
 * selection. CSS drops the ring on those targets after a pointer press only (base.css, #312). It
 * starts as keyboard: a screen reader, switch or voice control can move focus with no key heard
 * here, while a touch or mouse player presses before the app moves focus for them.
 */
export type InputModality = 'keyboard' | 'pointer';

/** Keys that navigate or press. Bare modifiers, typed characters and shortcut chords leave the modality as it was. */
const KEYBOARD_KEYS = new Set([
  'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' ', 'Escape',
]);

const set = (root: HTMLElement, modality: InputModality) => {
  if (root.dataset.input !== modality) root.dataset.input = modality;
};

/** Starts tracking; returns a function that stops it. Listens in the capture phase, ahead of handlers that stop propagation. */
export function trackInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  set(root, 'keyboard');
  const onKey = (event: KeyboardEvent) => {
    if (KEYBOARD_KEYS.has(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) set(root, 'keyboard');
  };
  const onPointer = () => set(root, 'pointer');
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', onPointer, true);
  return () => {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('pointerdown', onPointer, true);
  };
}
