import { useEffect, useReducer, useRef } from 'react';
import { HISTORY_ENTRY_EVENT } from '../game/route';

/** Marks the one history entry a pack holds. The URL is never changed, so share links are untouched. */
const PACK_ENTRY = 'brainrotPack';

const onPackEntry = () => {
  const state: unknown = history.state;
  return !!state && typeof state === 'object' && (state as Record<string, unknown>)[PACK_ENTRY] === true;
};

/** The pack's entry is still the current one, at the address it was added at. */
const stillOnEntry = (href: string) => onPackEntry() && location.href === href;

/**
 * Browser Back inside a pack goes back to the packs screen instead of leaving the site.
 *
 * Entering a pack (`inPack` turning true) adds one history entry (or reuses the current one when
 * it's an earlier pack's, reached with Forward), so entries never stack across packs. Back from it
 * calls `onBack`, the same handler as the pack's X. Leaving any other way (the X, Escape, the
 * summary's next-pack button) steps back over the entry, so the next Back leaves the page as it would
 * have before, and Forward onto the old entry reopens nothing.
 */
export const usePackHistory = (inPack: boolean, onBack: () => void) => {
  const onBackRef = useRef(onBack);
  /** This pack's entry is in history and current (or a fragment link was opened on top of it). */
  const heldRef = useRef(false);
  /** We stepped back over the entry ourselves; its popstate isn't the player's Back. */
  const poppingRef = useRef(false);
  /** Where the entry was added: Back lands on the page below it, at this same address. */
  const hrefRef = useRef('');
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    onBackRef.current = onBack;
  });

  useEffect(() => {
    if (inPack && !heldRef.current && !poppingRef.current) {
      if (!onPackEntry()) {
        history.pushState({ [PACK_ENTRY]: true }, '');
        window.dispatchEvent(new Event(HISTORY_ENTRY_EVENT));
      }
      heldRef.current = true;
      hrefRef.current = location.href;
    } else if (!inPack && heldRef.current) {
      heldRef.current = false;
      // Only step back while the entry is the current one: from a page or link opened over the pack,
      // Back already belongs to them (useRoute steps back onto the entry when they close).
      if (!stillOnEntry(hrefRef.current)) return;
      poppingRef.current = true;
      history.back();
    }
  });

  useEffect(() => {
    const onPopState = () => {
      if (poppingRef.current) {
        poppingRef.current = false;
        // A pack may have started while the step back was on its way: let it add its entry now.
        rerender();
        return;
      }
      // A fragment link opened over the pack (a shared pull) also fires popstate, at a new address.
      if (!heldRef.current || onPackEntry() || location.href !== hrefRef.current) return;
      heldRef.current = false;
      onBackRef.current();
      rerender();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Unmounted with the entry still held (the set changed under the summary): drop it.
  useEffect(() => () => {
    if (!heldRef.current) return;
    heldRef.current = false;
    if (stillOnEntry(hrefRef.current)) history.back();
  }, []);
};
