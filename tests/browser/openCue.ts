import { expect, type Page } from '@playwright/test';

/** Pause the real cue from mount, before a slow load can retire it. Reapplied on reload. */
export async function holdOpenCue(page: Page) {
  await page.addInitScript(() => {
    // Park on a visible frame after the paused animations start, so the finger can still be seen.
    document.addEventListener('animationstart', (event) => {
      if (!event.animationName.startsWith('open-cue-') || !(event.target instanceof Element)) return;
      for (const animation of event.target.getAnimations()) {
        if (animation instanceof CSSAnimation && animation.animationName === event.animationName) {
          animation.currentTime = Number(animation.effect!.getComputedTiming().duration) / 2;
        }
      }
    });
    const style = document.createElement('style');
    style.textContent = '.open-cue-travel, .open-cue-tear { animation-play-state: paused !important; }';
    const install = () => {
      if (!document.head) return;
      document.head.append(style);
      observer.disconnect();
    };
    const observer = new MutationObserver(install);
    observer.observe(document, { childList: true, subtree: true });
    install();
  });
}

/** The held cue must have reached a visible control point, not just exist at its transparent start. */
export async function expectOpenCueHeld(page: Page) {
  const cue = page.locator('.open-cue');
  await expect(cue.locator('.open-cue-finger')).toBeVisible();
  await expect.poll(() => cue.locator('.open-cue-travel').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect.poll(() => cue.evaluate((el) =>
    el.getAnimations({ subtree: true })
      .filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation && animation.animationName.startsWith('open-cue-'))
      .map((animation) => ({ name: animation.animationName, state: animation.playState })).sort((a, b) => a.name.localeCompare(b.name)),
  )).toEqual([{ name: 'open-cue-tear', state: 'paused' }, { name: 'open-cue-travel', state: 'paused' }]);
}

/** Finish the held CSS animations, exercising the browser's animationend and the real cue callback. */
export async function finishOpenCue(page: Page) {
  await expectOpenCueHeld(page);
  await page.locator('.open-cue').evaluate((el) => el.getAnimations({ subtree: true }).forEach((animation) => {
    if (animation instanceof CSSAnimation && animation.animationName.startsWith('open-cue-')) animation.finish();
  }));
}
