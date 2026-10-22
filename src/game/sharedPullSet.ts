import { isOpenable } from '../content/sets';
import type { SetDefinition } from '../engine';

/**
 * Whether the viewer of a shared pull can open packs of that exact set right now: the very same
 * id and version it was pulled from (a newer version has different cards), released and not
 * archived, listed on the packs screen, and no pack currently open (the set can't change under it).
 */
export const canOpenSharedSet = (set: SetDefinition, playableSets: readonly SetDefinition[], packBusy: boolean): boolean =>
  !packBusy && playableSets.some((p) => p.id === set.id && p.version === set.version && isOpenable(p));
