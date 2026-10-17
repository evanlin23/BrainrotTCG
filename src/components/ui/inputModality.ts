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
 * back. After Space or Enter a thin neutral outline stays on a control, so keyboard focus is never
 * invisible; after a pointer press nothing shows. It starts as keyboard: a screen reader, switch or voice control can
 * move focus with no key heard here, while a touch or mouse player presses before the app moves focus
 * for them.
 *
 * Focus a navigation key placed (Tab onto Open pack) is marked `data-ring-kept` until it leaves, so
 * pressing Space or Enter on it keeps its ring; the next script move after the press stays quiet.
 */
export type InputModality = 'keyboard' | 'press' | 'pointer';

/** Keys that navigate (ring on) or press (ring off). Bare modifiers, typed characters and shortcut chords leave the modality as it was. */
const KEYBOARD_KEYS = new Set([
  'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Escape',
]);
const PRESS_KEYS = new Set(['Enter', ' ']);

/** Marks the element a navigation key focused; base.css keeps its ring under "press". */
export const RING_KEPT = 'data-ring-kept';

const set = (root: HTMLElement, modality: InputModality) => {
  if (root.dataset.input !== modality) root.dataset.input = modality;
};

/** Starts tracking; returns a function that stops it. Listens in the capture phase, ahead of handlers that stop propagation. */
export function trackInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  set(root, 'keyboard');
  // True from a navigation keydown to its keyup: focus that lands meanwhile was placed by that key.
  let navigating = false;
  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (KEYBOARD_KEYS.has(event.key)) {
      navigating = true;
      set(root, 'keyboard');
    } else if (PRESS_KEYS.has(event.key)) {
      navigating = false;
      set(root, 'press');
    }
  };
  const onKeyUp = () => { navigating = false; };
  const onPointer = () => {
    navigating = false;
    doc.querySelector(`[${RING_KEPT}]`)?.removeAttribute(RING_KEPT);
    set(root, 'pointer');
  };
  const onFocusIn = (event: FocusEvent) => {
    if (navigating && event.target instanceof Element) event.target.setAttribute(RING_KEPT, '');
  };
  const onFocusOut = (event: FocusEvent) => {
    if (event.target instanceof Element) event.target.removeAttribute(RING_KEPT);
  };
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('keyup', onKeyUp, true);
  doc.addEventListener('pointerdown', onPointer, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  return () => {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('keyup', onKeyUp, true);
    doc.removeEventListener('pointerdown', onPointer, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusOut, true);
  };
}
