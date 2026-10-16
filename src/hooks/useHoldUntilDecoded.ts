import { useEffect, type RefObject } from 'react';
import { holdLive } from '../game/admission';

/** The longest a summary keeps optional work waiting for its cards to decode. */
export const SUMMARY_DECODE_CAP_MS = 2000;

/**
 * While `active`, optional work (re-opening, pull checks) waits until the images under `ref` have
 * decoded, or `capMs` has passed, so a slow or failed decode never holds it for long. Unmounting or
 * turning `active` off releases it at once.
 */
export function useHoldUntilDecoded(ref: RefObject<HTMLElement | null>, active: boolean, capMs = SUMMARY_DECODE_CAP_MS) {
  useEffect(() => {
    if (!active) return;
    const release = holdLive();
    const cap = window.setTimeout(release, capMs);
    const images = [...(ref.current?.querySelectorAll('img') ?? [])];
    void Promise.allSettled(images.map((img) => img.decode?.())).then(release);
    return () => {
      window.clearTimeout(cap);
      release();
    };
  }, [ref, active, capMs]);
}
