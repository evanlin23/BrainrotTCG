import { STORAGE_KEYS } from '../constants';

/** The opening cue plays this many times on a device, at most (DESIGN.md Flow 2). */
export const OPEN_CUE_MAX_PLAYS = 2;

/** How many times the cue has played here. Unreadable storage counts as played, so the cue never loops. */
export const readOpenCuePlays = (): number => {
  try {
    const plays = Number(localStorage.getItem(STORAGE_KEYS.OPEN_CUE_PLAYS) ?? 0);
    return Number.isInteger(plays) && plays >= 0 ? Math.min(plays, OPEN_CUE_MAX_PLAYS) : OPEN_CUE_MAX_PLAYS;
  } catch {
    return OPEN_CUE_MAX_PLAYS;
  }
};

const writeOpenCuePlays = (plays: number) => {
  try {
    localStorage.setItem(STORAGE_KEYS.OPEN_CUE_PLAYS, String(Math.min(plays, OPEN_CUE_MAX_PLAYS)));
  } catch {
    // A device that can't keep the count still plays it once per visit, never more: the hook holds it per mount.
  }
};

/** The cue is starting its next play. */
export const recordOpenCuePlay = () => writeOpenCuePlays(readOpenCuePlays() + 1);

/** The player touched the pack: they understand it, so the cue is done on this device. */
export const markOpenCueUnderstood = () => writeOpenCuePlays(OPEN_CUE_MAX_PLAYS);
