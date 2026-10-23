/**
 * Why a tear didn't open a pack: its ticket or the save refused it ('failed', and nothing was dealt),
 * another tab changed the save, so this tab can't record one until it reloads ('blocked'), or the
 * player record can't be read, so no ticket is claimed until the player chooses what to do ('unreadable', #1052).
 */
export type PackRefusal = 'failed' | 'blocked' | 'unreadable';

/** What the player is told, in plain words, and what the button under it says. */
export const REFUSAL_COPY: Record<PackRefusal, { message: string; action: string }> = {
  failed: { message: "This pack didn't open, and no cards were dealt.", action: 'Try again' },
  blocked: { message: 'Your save changed in another tab, so this pack stayed sealed. Reload to keep opening packs here.', action: 'Reload and try again' },
  unreadable: {
    message: "Your player record in this browser is damaged and can't be read, so this pack stayed sealed. Nothing was lost."
      + ' In Save & backup you can restore a backup, download the damaged record, or start a new player.',
    action: 'Open Save & backup',
  },
};
