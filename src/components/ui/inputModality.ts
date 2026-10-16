/**
 * Which kind of input the player last used, as `data-input` on <html>: "keyboard" after a key that
 * moves or presses (Tab, arrows, Enter, Space, Escape), "pointer" after a mouse, pen or touch press,
 * and "pointer" until either happens.
 *
 * The app moves focus by script as a pack opens (the next card, the result, a dialog). Browsers ring
 * script focus that no click put there, and on a phone a tap rarely does, so that ring reads as a
 * selection. CSS keeps the ring on those targets for keyboard players only (base.css, #312).
 */
export type InputModality = 'keyboard' | 'pointer';

/** Keys that navigate or press. Bare modifiers and typed characters leave the modality as it was. */
const KEYBOARD_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape']);

const set = (root: HTMLElement, modality: InputModality) => {
  if (root.dataset.input !== modality) root.dataset.input = modality;
};

/** Starts tracking; returns a function that stops it. Listens in the capture phase, ahead of handlers that stop propagation. */
export function trackInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  set(root, 'pointer');
  const onKey = (event: KeyboardEvent) => {
    if (KEYBOARD_KEYS.has(event.key)) set(root, 'keyboard');
  };
  const onPointer = () => set(root, 'pointer');
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', onPointer, true);
  return () => {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('pointerdown', onPointer, true);
  };
}
