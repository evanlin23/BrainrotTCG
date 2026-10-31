import { STORAGE_KEYS } from '../constants';

/**
 * Whether the Packs sheet (the set picker's list of every pack) has been opened on this device, from
 * anywhere: the landing's "Change pack · N available" stops showing once it has (DESIGN.md "Flow", item 8).
 * A device fact like the opening cue's count, never part of a save or a player identity.
 */
const SEEN = '1';

// An opening that storage refused (full or blocked) still holds for this visit, so the control does
// not come back on the next pack.
let unsavedSeen = false;

export const hasSeenPacksSheet = (): boolean => {
  if (unsavedSeen) return true;
  try {
    return localStorage.getItem(STORAGE_KEYS.PACKS_SHEET_SEEN) === SEEN;
  } catch {
    return false;
  }
};

/** The Packs sheet opened. False when storage refused it: it holds for this visit only. */
export const markPacksSheetSeen = (): boolean => {
  try {
    localStorage.setItem(STORAGE_KEYS.PACKS_SHEET_SEEN, SEEN);
    unsavedSeen = false;
    return true;
  } catch {
    unsavedSeen = true;
    return false;
  }
};
