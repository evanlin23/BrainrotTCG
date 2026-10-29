/** The idle cue's keyframes (PackOpener.css): a lift of the top strip, run on its transform. */
const IDLE_LIFT = 'pack-idle-lift';

/**
 * Ends the sealed pack's idle cue and lets that take effect before the tear. The tear slides the strip
 * away with a transition on its transform, and Chrome starts no transition on a property whose animation
 * ends in the same style update: a key (or a click without a press) that tears an idle pack would drop the
 * strip into place with no slide. A press ends the cue by itself, a render before the tear; a key has no
 * press to do it, so it ends here, then a style read applies it, so the tear's update starts from rest.
 */
export const endIdleCue = (pack: HTMLElement | null) => {
  // Where animations can't be listed (jsdom), nothing runs, so there is nothing to end.
  if (typeof pack?.getAnimations !== 'function') return;
  for (const animation of pack.getAnimations({ subtree: true })) {
    if ((animation as CSSAnimation).animationName !== IDLE_LIFT) continue;
    const target = (animation.effect as KeyframeEffect | null)?.target;
    animation.cancel();
    if (target) void getComputedStyle(target).transform;
  }
};
