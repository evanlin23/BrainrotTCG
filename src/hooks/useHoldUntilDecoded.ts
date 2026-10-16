import { useEffect, useRef, type RefObject } from 'react';
import { holdLive } from '../game/admission';

/** The longest a summary keeps optional work waiting for its cards to decode. */
export const SUMMARY_DECODE_CAP_MS = 2000;

/**
 * While `active`, optional work (re-opening, pull checks) waits until the images under `ref` show
 * and have decoded, or `capMs` has passed, so a slow or failed decode never holds it for long. An
 * image still rendering (`data-state="rendering"`: a finish whose inks are being prepared) or given a
 * new src is waited for again. Unmounting or turning `active` off releases it at once. The cap counts from the first time
 * it was active, so covering and uncovering the summary can't stretch the wait.
 */
export function useHoldUntilDecoded(ref: RefObject<HTMLElement | null>, active: boolean, capMs = SUMMARY_DECODE_CAP_MS) {
  const deadline = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    deadline.current ??= performance.now() + capMs;
    const left = Math.min(deadline.current - performance.now(), capMs);
    if (left <= 0) return;
    const release = holdLive();
    const cap = window.setTimeout(release, left);
    const root = ref.current;
    let latest = 0;
    const settle = () => {
      const check = ++latest;
      const images = [...(root?.querySelectorAll('img') ?? [])];
      if (images.some((img) => img.dataset.state === 'rendering')) return;
      void Promise.allSettled(images.map((img) => img.decode?.())).then(() => {
        if (check === latest) release();
      });
    };
    const observer = root ? new MutationObserver((records) => {
      if (records.some((r) => r.type === 'childList' || r.target instanceof HTMLImageElement)) settle();
    }) : undefined;
    observer?.observe(root!, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'data-state'] });
    settle();
    return () => {
      observer?.disconnect();
      window.clearTimeout(cap);
      release();
    };
  }, [ref, active, capMs]);
}
