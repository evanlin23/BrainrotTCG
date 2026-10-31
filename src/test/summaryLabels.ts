import { DEFAULT_SET_ID, getLatestSet } from '../content/sets';

/** The summary's primary action, named for the set being opened (the pack new players land on unless a test selects another). */
export const openAgain = (setId: string = DEFAULT_SET_ID) => `Open ${getLatestSet(setId)!.name} again`;
