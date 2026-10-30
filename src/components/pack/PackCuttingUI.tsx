import { useIsPresent } from 'framer-motion';
import { MoveHorizontal, Pointer } from 'lucide-react';
import { useEffect, useRef, useState, type AnimationEvent, type MouseEvent, type PointerEvent, type Ref, type RefObject } from 'react';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import type { CutPoint } from '../../hooks/usePackCutter';
import type { SetDefinition } from '../../engine';
import { packArtSettled } from '../../game/packArt';
import { seamBands } from './seamTrail';
import { REFUSAL_COPY, type PackRefusal } from './refusal';

interface PackCuttingUIProps {
  packRef: RefObject<HTMLDivElement | null>;
  packDesign: string;
  set: SetDefinition;
  /** The last tear didn't open a pack: say why, with a way to try again. */
  refusal?: PackRefusal | null;
  /** Opens the pack exactly as a finished swipe does: the pack is the control for a tap, a click, a key or a screen reader. */
  onOpen: () => void;
  /** The refusal's button: open again, or reload for a save another tab changed. */
  onRetry?: () => void;
  retryButtonRef?: Ref<HTMLButtonElement>;
  isCutting: boolean;
  /** A press landed on the tear line and hasn't gone across yet: light the line under it. */
  pressing?: boolean;
  isPackCut: boolean;
  /** The pack is torn but its ticket is still being worked out (a slow phone). */
  waiting?: boolean;
  /** A press just missed the tear line: show where to swipe. */
  nudging?: boolean;
  /** A swipe was let go too short to open: the pack springs back and the hint says to go farther or tap the pack (#803). */
  fellShort?: boolean;
  cutPoints: CutPoint[];
  /** The canvas the swipe's sparks are drawn on (useSparks). */
  sparkCanvasRef?: Ref<HTMLCanvasElement>;
  /** The new player's cue: a finger and a partial tear play along the seam ('play'), or sit still under reduced motion ('still'). */
  cue?: 'play' | 'still' | null;
  /** The cue's play ran to its end. */
  onCueEnd?: () => void;
  /** The pack was touched (pressed, clicked or keyed): the cue stops for good. */
  onTouch?: () => void;
}

/** A press that moves farther than this (px) before its release was a drag, not a tap. */
export const TAP_SLOP_PX = 10;

const PackCuttingUI = ({
  packRef,
  packDesign,
  set,
  refusal = null,
  onOpen,
  onRetry,
  retryButtonRef,
  isCutting,
  pressing = false,
  isPackCut,
  waiting = false,
  nudging = false,
  fellShort = false,
  cutPoints,
  sparkCanvasRef,
  cue = null,
  onCueEnd,
  onTouch,
}: PackCuttingUIProps) => {
  const touch = useCoarsePointer();
  // The torn pack flies off over the first card (#312 P2-6), so it stops being the pack the moment it
  // starts leaving: its marker goes (it is no longer the control to find, query or key), while focus
  // stays on it until the first card takes it, which it does only from the pack or the page.
  const leaving = !useIsPresent();
  // A drag that ends over the pack ends in a click too, which is not a tap: only a press that never
  // strayed past TAP_SLOP_PX, at any point before its release, opens it.
  const press = useRef<{ id: number; x: number; y: number; farthest: number } | null>(null);
  // A pack that leaves before its art loads or fails (the player moved on from Open) still lets the deferred
  // downloads start, so they aren't held for the rest of the visit.
  useEffect(() => packArtSettled, []);
  // A finger is down on the pack, wherever it landed: the idle cue waits for it to lift (a press below the
  // tear line sets neither `pressing` nor `isCutting`, and its nudge timer can run out under a slow hold).
  const [held, setHeld] = useState(false);
  const heldId = useRef<number | null>(null);
  const onPressStart = (event: PointerEvent) => {
    press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, farthest: 0 };
    heldId.current = event.pointerId;
    setHeld(true);
    onTouch?.();
  };
  useEffect(() => {
    const track = (event: globalThis.PointerEvent) => {
      const start = press.current;
      if (start && event.pointerId === start.id) start.farthest = Math.max(start.farthest, Math.hypot(event.clientX - start.x, event.clientY - start.y));
    };
    // A press that ends off the pack, or is taken over by the browser (a scroll, a call), gets no click on it:
    // forget it, so a later click with no press before it (a screen reader's) is not judged by it.
    const forget = (event: globalThis.PointerEvent) => {
      const start = press.current;
      if (!start || event.pointerId !== start.id) return;
      if (event.type === 'pointercancel' || !(event.target instanceof Element && event.target.closest('[data-pack-open]'))) press.current = null;
    };
    const release = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== heldId.current) return;
      heldId.current = null;
      setHeld(false);
    };
    window.addEventListener('pointermove', track);
    window.addEventListener('pointerup', forget);
    window.addEventListener('pointercancel', forget);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', forget);
      window.removeEventListener('pointercancel', forget);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);
  const onPackClick = (event: MouseEvent) => {
    const start = press.current;
    press.current = null;
    // A click with no press before it (a screen reader's, or a switch's) is always a tap.
    if (start && Math.max(start.farthest, Math.hypot(event.clientX - start.x, event.clientY - start.y)) > TAP_SLOP_PX) return;
    onOpen();
  };
  // Sealed and untouched (DESIGN.md Flow 2): the top strip lifts every few seconds and settles back, for as
  // long as the pack waits. The new player's finger plays first (cue), and a press, a tear, a short swipe, a
  // missed press or a finger still down each put the strip down until the pack is idle again.
  const idle = !cue && !isPackCut && !isCutting && !pressing && !held && !nudging && !fellShort && !refusal && !leaving;
  const onCueAnimationEnd = (event: AnimationEvent) => {
    if (event.target === event.currentTarget) onCueEnd?.();
  };

  return (
    <>
      <div className="pack-shell-wrap" inert={leaving || undefined}>
        {/* The one Open pack control: a swipe along the seam, a tap or click, or Space or Enter with focus on it (useKeyboardControls) all run the same opening. Its name carries the set; while the ticket works it says Opening… and ignores input. */}
        <div
          ref={packRef}
          role="button"
          tabIndex={0}
          aria-label={isPackCut ? 'Opening…' : `Open pack, ${set.name}`}
          aria-busy={isPackCut || undefined}
          aria-disabled={isPackCut || undefined}
          data-pack-open={leaving ? undefined : true}
          data-open-cue={cue && !isPackCut ? cue : undefined}
          onPointerDown={onPressStart}
          onClick={onPackClick}
          className={`pack-shell quiet-focus ${isCutting ? 'is-cutting' : ''} ${pressing && !isCutting ? 'is-pressed' : ''} ${isPackCut ? 'is-cut' : ''} ${nudging && !isCutting && !pressing ? 'is-nudged' : ''} ${fellShort && !isPackCut && !isCutting && !pressing ? 'is-short' : ''} ${idle ? 'is-idle' : ''}`}
          style={{ '--pack-mask': `url("${packDesign}")` } as React.CSSProperties}
        >
          {/* Each half carries its foil with it when the wrapper tears. */}
          <div className="pack-half pack-half-bottom">
            <img src={packDesign} alt="" draggable="false" onLoad={packArtSettled} onError={packArtSettled} />
            <span className="pack-foil" aria-hidden="true" />
          </div>
          <div className="pack-half pack-half-top" aria-hidden="true">
            <img src={packDesign} alt="" draggable="false" />
            <span className="pack-foil" aria-hidden="true" />
          </div>
          {/* The top strip's loose piece: the pack art carries the set's name and its hero, and the open button's name says it again to a screen reader. */}
          <div className="pack-top-piece" />
          <div className="tear-guide" />
          {/* The cue (DESIGN.md Flow 2): a finger drags a partial tear along the seam, at most twice, and stops at the first touch. Under reduced motion it is the same mark, still. */}
          {cue && !isPackCut && (
            <div className="open-cue" aria-hidden="true">
              <span className="open-cue-tear" />
              <span className="open-cue-travel" onAnimationEnd={onCueAnimationEnd}>
                <Pointer className="open-cue-finger" />
              </span>
            </div>
          )}
          {/* Only while there is a pack left to tear. */}
          {!isPackCut && (
            <div className="swipe-hint">
              <MoveHorizontal className="swipe-hint-icon" aria-hidden="true" />
              <span className="swipe-hint-text">
                {fellShort ? (touch ? 'Swipe farther, or tap the pack' : 'Drag farther, or click the pack') : nudging ? (touch ? 'Swipe along the dotted line' : 'Drag along the dotted line') : touch ? 'Swipe across to open' : 'Drag across, or click'}
              </span>
            </div>
          )}
          {/* The cut shows as a thin foil seam that fades out behind the finger (#267). */}
          {cutPoints.length > 1 && (
            <svg className="cut-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="pack-seam-foil" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">
                  <stop className="seam-stop-1" offset="0" />
                  <stop className="seam-stop-2" offset="0.3" />
                  <stop className="seam-stop-3" offset="0.55" />
                  <stop className="seam-stop-4" offset="0.8" />
                  <stop className="seam-stop-5" offset="1" />
                </linearGradient>
              </defs>
              <g className="cut-line">
                {seamBands(cutPoints).map((band, index) => (
                  <g key={index} opacity={band.opacity}>
                    <polyline className="cut-line-foil" stroke="url(#pack-seam-foil)" points={band.points} />
                    <polyline className="cut-line-core" points={band.points} />
                  </g>
                ))}
              </g>
            </svg>
          )}
          <canvas ref={sparkCanvasRef} className="spark-layer" aria-hidden="true" />
        </div>
        {/* Seen, not read: the pack's live region (PackOpener) says it once. The pack's own name already says Opening…, so this says why it is taking a while. */}
        {waiting && !refusal && !leaving && (
          <p className="pack-hint is-waiting" aria-hidden="true">
            Taking a moment…
          </p>
        )}
      </div>
      {/* Under the tear line: why the last tear didn't open, with a way to try again. */}
      {!leaving && refusal && (
        <div className="pack-actions">
          <div className="pack-refusal">
            <p className="pack-refusal-text">{REFUSAL_COPY[refusal].message}</p>
            <button type="button" ref={retryButtonRef} className="btn btn--primary btn--sm pack-retry-button quiet-focus" onClick={onRetry}>
              {REFUSAL_COPY[refusal].action}
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default PackCuttingUI;
