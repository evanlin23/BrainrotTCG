/**
 * Pictures the first screen doesn't show (the next pack's cards, the card back) wait until the sealed
 * pack's art has loaded or failed, so on a slow connection they don't share its bandwidth and the
 * pack can be opened sooner (#776). They still download before the tear, as before.
 */
let settle!: () => void;
const settled = new Promise<void>((resolve) => { settle = resolve; });

/** The sealed pack's art finished loading (or failed): later downloads may start. */
export const packArtSettled = (): void => settle();

/** Run `task` once the sealed pack's art has settled (at once, from a microtask, if it already has). */
export const afterPackArt = (task: () => void): void => {
  void settled.then(task);
};
