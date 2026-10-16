/**
 * Why a tear didn't open a pack: its ticket or the save refused it ('failed', and nothing was dealt),
 * or another tab changed the save, so this tab can't record one until it reloads ('blocked').
 */
export type PackRefusal = 'failed' | 'blocked';

/** What the player is told, in plain words, and what the button under it says. */
export const REFUSAL_COPY: Record<PackRefusal, { message: string; action: string }> = {
  failed: { message: "This pack didn't open, and no cards were dealt.", action: 'Try again' },
  blocked: { message: 'Your save changed in another tab, so this pack stayed sealed. Reload to keep opening packs here.', action: 'Reload and try again' },
};
