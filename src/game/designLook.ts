/**
 * Exploration for #1138 (card and pack redesign): three draft visual directions the owner picks from.
 * `?look=a`, `?look=b` or `?look=c` in the address sets `data-look` on <html>, and the look's
 * stylesheet (styles/looks/) redraws the card frame, the card backs and the pack wrappers from it.
 * Without the parameter nothing changes. It is not a setting: nothing is saved, and proofs, packs
 * and rewards are untouched.
 *
 *   a: "Slab"    a clean premium TCG frame, guilloche backs, a printed foil pouch
 *   b: "Sticker" a loud sticker-bomb frame, checker backs, a sticker-covered bag
 *   c: "Signal"  a glitchy neon HUD frame, scanline backs, a holo-foil pack
 */
export const DESIGN_LOOKS = ['a', 'b', 'c'] as const;
export type DesignLook = (typeof DESIGN_LOOKS)[number];

/** The look an address asks for, if it names one of the drafts. */
export const designLookFrom = (search: string): DesignLook | undefined => {
  const asked = new URLSearchParams(search).get('look');
  return DESIGN_LOOKS.find((look) => look === asked);
};

/** Mark <html> with the asked-for look before the first paint. */
export const applyDesignLook = (root: HTMLElement = document.documentElement, search: string = window.location.search): void => {
  const look = designLookFrom(search);
  if (look) root.dataset.look = look;
  else delete root.dataset.look;
};
