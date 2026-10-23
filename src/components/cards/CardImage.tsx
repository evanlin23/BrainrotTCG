import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ImgHTMLAttributes, type MouseEvent } from 'react';
import type { Finish } from '../../engine';
import { holdFinishedCardImage } from '../../game/finishImage';
import { BLANK_CARD_ART as BLANK, isApprovedCardArt } from '../../game/cardArt';
import { cardFinishThumbUrl } from '../../content/art';
import '../../styles/CardImage.css';

interface CardImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  finish?: Finish | null;
  /** Small views can use ready-made finishes instead of rendering a full-size image. */
  thumbnail?: boolean;
  /** Offer a Retry button when the image fails. Only where a button may sit beside the image (not inside one). */
  retry?: boolean;
}

// Each Retry press, or the device coming back online, retries every card image that failed before it.
let retryRound = 0;
const retryListeners = new Set<() => void>();
const retryFailedCardImages = () => {
  retryRound += 1;
  for (const listener of retryListeners) listener();
};
const subscribeRetry = (listener: () => void) => {
  if (retryListeners.size === 0) window.addEventListener('online', retryFailedCardImages);
  retryListeners.add(listener);
  return () => {
    retryListeners.delete(listener);
    if (retryListeners.size === 0) window.removeEventListener('online', retryFailedCardImages);
  };
};
const getRetryRound = () => retryRound;

// One observer marks loading images scrolled out of view, so their shimmer pauses (CardImage.css).
let offscreenObserver: IntersectionObserver | undefined;
const watchedOffscreen = new Set<Element>();
const watchOffscreen = (element: Element) => {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  offscreenObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (watchedOffscreen.has(entry.target)) entry.target.toggleAttribute('data-offscreen', !entry.isIntersecting);
    }
  });
  watchedOffscreen.add(element);
  offscreenObserver.observe(element);
  return () => {
    watchedOffscreen.delete(element);
    offscreenObserver?.unobserve(element);
    element.removeAttribute('data-offscreen');
  };
};

interface ImageStatus {
  /** Card, finish, variant and attempt this status belongs to; any change starts from a fresh status. */
  id: string;
  thumbFailed?: boolean;
  /** The finished image's URL, or the plain art when the finish could not be rendered. */
  rendered?: string;
  /** The displayed URL whose load event has arrived. */
  loaded?: string;
  /** The URL whose pixels are decoded (or whose decode was given up on), so the face may swap in. */
  decoded?: string;
  /** The retry round the image failed in; a later round retries it. */
  failedIn?: number;
}

/** The longest loaded art waits for its decode before it shows anyway. */
const DECODE_WAIT_MS = 1000;

/**
 * Keep the same img element and existing holo/misprint layers, changing only its printed frame. The
 * box is reserved at the card's shape, and `data-state` (rendering, loading, ready, failed, blocked)
 * drives the placeholder, so loading never shifts layout and a failure never shows a broken image.
 * Art this build won't request (an unknown historical card's stored address, see game/cardArt) is
 * `blocked`: the placeholder stays, nothing is fetched and Retry isn't offered.
 */
const CardImage = ({
  src, finish, thumbnail = false, retry = false, className, style, onLoad, onError, draggable = false, ...props
}: CardImageProps) => {
  const round = useSyncExternalStore(subscribeRetry, getRetryRound, getRetryRound);
  const [attempt, setAttempt] = useState(0);
  const id = `${finish ?? ''}:${src}:${thumbnail ? 'thumb' : 'full'}#${attempt}`;
  const [stored, setStored] = useState<ImageStatus>({ id });
  const status = stored.id === id ? stored : { id };
  const update = (patch: Omit<ImageStatus, 'id'>) =>
    setStored((previous) => ({ ...(previous.id === id ? previous : { id }), ...patch }));

  const blocked = !isApprovedCardArt(src);
  const availableThumb = thumbnail ? cardFinishThumbUrl(src, finish) : undefined;
  // A failed thumbnail falls back to the existing full-size finish renderer.
  const thumb = status.thumbFailed ? undefined : availableThumb;
  const needsRender = Boolean(finish) && !thumb && !blocked;
  const shown = blocked ? undefined : thumb ?? (needsRender ? status.rendered : src);
  const failed = status.failedIn !== undefined;
  const state = blocked ? 'blocked' : failed ? 'failed' : !shown ? 'rendering' : status.decoded === shown ? 'ready' : 'loading';

  useEffect(() => {
    if (!finish || !needsRender) return;
    const finished = holdFinishedCardImage(src, finish);
    let cancelled = false;
    finished.image.then((result) => {
      if (!cancelled) update({ rendered: result });
    }).catch((error: unknown) => {
      // A render this image let go of may be dropped before it starts (an AbortError); that is not a failure.
      if (cancelled && error instanceof Error && error.name === 'AbortError') return;
      // Any other failure is still reported after unmount, but only a mounted image falls back to the plain art.
      console.error('Could not render card finish', error);
      if (!cancelled) update({ rendered: src });
    });
    // Effects clean up after the commit that stopped showing this URL, so it is never released while mounted.
    return () => {
      cancelled = true;
      finished.release();
    };
    // `id` covers src, finish, thumbnail and attempt; `update` only closes over `id`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, needsRender]);

  const imageRef = useRef<HTMLImageElement>(null);
  // A fresh status for a URL the img already shows (a card without a finish switching between its
  // thumbnail and full-size view keeps the same src) gets no new load event: take the load it had, and
  // the decode, so no loading frame paints in between.
  useLayoutEffect(() => {
    const img = imageRef.current;
    if (state === 'loading' && status.loaded !== shown && img?.complete && img.naturalWidth > 0 && img.getAttribute('src') === shown) update({ loaded: shown, decoded: shown });
    // `update` only closes over `id`, which changes `state`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, shown]);
  // Show the art only once it is decoded, so a slow device never swaps the placeholder for an empty
  // frame (#762). A decode that fails, is missing or hangs past the wait still shows the loaded image,
  // and moving on to another URL or unmounting cancels the wait.
  useEffect(() => {
    if (!shown || status.loaded !== shown || status.decoded === shown) return;
    let waiting = true;
    const show = () => {
      if (!waiting) return;
      waiting = false;
      clearTimeout(timer);
      update({ decoded: shown });
    };
    const timer = setTimeout(show, DECODE_WAIT_MS);
    Promise.resolve(imageRef.current?.decode?.()).then(show, show);
    return () => {
      waiting = false;
      clearTimeout(timer);
    };
    // `update` only closes over `id`, which is covered here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, shown, status.loaded, status.decoded]);
  const shimmering = state === 'rendering' || state === 'loading';
  useEffect(() => (shimmering && imageRef.current ? watchOffscreen(imageRef.current) : undefined), [shimmering]);

  // A retry round after the failure starts a fresh attempt (adjusting state while rendering, as React suggests).
  if (failed && round > status.failedIn!) setAttempt(attempt + 1);

  const retryButton = useRef<HTMLButtonElement>(null);
  /** Where this image's Retry press parked focus while the button is gone, until the attempt settles. */
  const parkedFocus = useRef<Element | null>(null);
  const retryNow = (event: MouseEvent<HTMLButtonElement>) => {
    // The button goes away while the image reloads: keep focus in the surrounding dialog or card.
    const holder = event.currentTarget.parentElement?.closest<HTMLElement>('[tabindex]');
    holder?.focus({ preventScroll: true });
    parkedFocus.current = holder ?? document.body;
    retryFailedCardImages();
  };
  useEffect(() => {
    if (state !== 'ready' && state !== 'failed') return;
    const parked = parkedFocus.current;
    parkedFocus.current = null;
    // Failed again: hand focus back to the new Retry button, unless the player has moved it meanwhile.
    if (state === 'failed' && parked && (document.activeElement ?? document.body) === parked) {
      retryButton.current?.focus({ preventScroll: true });
    }
  }, [state]);

  const image = (
    <img
      draggable={draggable}
      {...props}
      ref={imageRef}
      className={className ? `card-image ${className}` : 'card-image'}
      style={style}
      src={failed || !shown ? BLANK : shown}
      data-state={state}
      onLoad={(event) => {
        if (!failed && shown && event.currentTarget.getAttribute('src') === shown) update({ loaded: shown });
        onLoad?.(event);
      }}
      onError={(event) => {
        const current = event.currentTarget.getAttribute('src');
        if (thumb && current === thumb) update({ thumbFailed: true });
        else if (!failed && shown && current === shown) update({ failedIn: round });
        onError?.(event);
      }}
    />
  );
  if (!retry || !failed) return image;
  return (
    <>
      {image}
      <button
        ref={retryButton}
        type="button"
        className="btn btn--secondary card-image-retry quiet-focus"
        aria-label={`Retry loading ${props.alt || 'card image'}`}
        onClick={retryNow}
      >
        Retry
      </button>
    </>
  );
};

export default CardImage;
