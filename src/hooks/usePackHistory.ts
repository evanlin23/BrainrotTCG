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
 * Something of this site is below the current entry, so stepping back stays here and fires popstate.
 * The Navigation API knows; without it, a tab with one entry is the only sure sign nothing is.
 */
const canStepBack = () => {
  const navigation = (window as { navigation?: { canGoBack?: unknown } }).navigation;
  return typeof navigation?.canGoBack === 'boolean' ? navigation.canGoBack : history.length > 1;
};

/** Drops the current entry's pack mark in place, keeping the rest of its state. */
const unmarkEntry = () => {
  const state: unknown = history.state;
  const rest = { ...(state && typeof state === 'object' ? state as Record<string, unknown> : {}) };
  delete rest[PACK_ENTRY];
  history.replaceState(rest, '');
  window.dispatchEvent(new Event(HISTORY_ENTRY_EVENT));
};

/** The entry this page loaded on has been checked (once per load, however often the opener remounts). */
let loadChecked = false;

/**
 * An unmounted opener's step back is still on its way. Until it lands, the entry it leaves is current and
 * still marked, so a new opener would reuse it and then read that step back as the player's Back.
 */
let strayBack = false;
const strayLanded = new Set<() => void>();
/** A step back that hasn't landed by now never will (no popstate came), so packs stop waiting on it. */
export const STRAY_BACK_TIMEOUT_MS = 1000;
const stepBackAfterUnmount = () => {
  strayBack = true;
  const land = () => {
    window.clearTimeout(timer);
    window.removeEventListener('popstate', land);
    strayBack = false;
    strayLanded.forEach((landed) => landed());
  };
  const timer = window.setTimeout(land, STRAY_BACK_TIMEOUT_MS);
  window.addEventListener('popstate', land, { once: true });
  history.back();
};

/**
 * Browser Back inside a pack goes back to the packs screen instead of leaving the site.
 *
 * Entering a pack (`inPack` turning true) adds one history entry (or reuses the current one when
 * it's an earlier pack's, reached with Forward), so entries never stack across packs. Back from it
 * calls `onBack`, the same handler as the pack's X. Leaving any other way (the X, Escape, the
 * summary's Open again button) steps back over the entry, so the next Back leaves the page as it would
 * have before, and Forward onto the old entry reopens nothing. A page loaded (or reloaded) on a pack's
 * entry has no pack, so it steps back over that entry the same way, and the first Back leaves (or, with
 * nothing of ours below it, just stops it being a pack's entry).
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
    if (loadChecked) return;
    loadChecked = true;
    // No pack survives a load: an entry left by one before it (a reload mid-pack) is stale.
    if (!onPackEntry() || heldRef.current) return;
    // Nothing of ours below it (a restored tab can keep just this entry): a step back would do nothing,
    // and no popstate would ever clear poppingRef, so later packs would add no entry. Unmark it instead.
    if (!canStepBack()) {
      unmarkEntry();
      return;
    }
    poppingRef.current = true;
    history.back();
  }, []);

  useEffect(() => {
    if (inPack && !heldRef.current && !poppingRef.current && !strayBack) {
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
    strayLanded.add(rerender);
    return () => {
      window.removeEventListener('popstate', onPopState);
      strayLanded.delete(rerender);
    };
  }, []);

  // Unmounted with the entry still held (the set changed under the summary): drop it.
  useEffect(() => () => {
    if (!heldRef.current) return;
    heldRef.current = false;
    if (stillOnEntry(hrefRef.current)) stepBackAfterUnmount();
  }, []);
};
