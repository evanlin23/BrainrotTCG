import { STORAGE_KEYS } from '../constants';

/** The first-card cue plays this many times on a device, at most (DESIGN.md Flow 3). */
export const FIRST_CARD_CUE_MAX_PLAYS = 1;

/** How many times the cue has played here. Unreadable storage counts as played, so the cue never loops. */
export const readFirstCardCuePlays = (): number => {
  try {
    const plays = Number(localStorage.getItem(STORAGE_KEYS.FIRST_CARD_CUE_PLAYS) ?? 0);
    return Number.isInteger(plays) && plays >= 0 ? Math.min(plays, FIRST_CARD_CUE_MAX_PLAYS) : FIRST_CARD_CUE_MAX_PLAYS;
  } catch {
    return FIRST_CARD_CUE_MAX_PLAYS;
  }
};

/** The cue is starting its play. */
export const recordFirstCardCuePlay = () => {
  try {
    localStorage.setItem(STORAGE_KEYS.FIRST_CARD_CUE_PLAYS, String(Math.min(readFirstCardCuePlays() + 1, FIRST_CARD_CUE_MAX_PLAYS)));
  } catch {
    // A device that can't keep the count still plays it once per visit, never more: the hook holds it per mount.
  }
};
