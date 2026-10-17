import { useIsPresent } from 'framer-motion';
import { MoveHorizontal } from 'lucide-react';
import type { Ref, RefObject } from 'react';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import type { CutPoint } from '../../hooks/usePackCutter';
import { SPARK_LIFETIME_MS, type Spark } from '../../hooks/useSparks';
import type { SetDefinition } from '../../engine';
import { seamBands } from './seamTrail';
import { REFUSAL_COPY, type PackRefusal } from './refusal';

interface PackCuttingUIProps {
  packRef: RefObject<HTMLDivElement | null>;
  packDesign: string;
  set: SetDefinition;
  /** The last tear didn't open a pack: say why, with a way to try again, in place of the Open pack button. */
  refusal?: PackRefusal | null;
  /** Opens the pack exactly as a finished swipe does: the control for a tap, a click, a key or a screen reader. */
  onOpen: () => void;
  /** The refusal's button: open again, or reload for a save another tab changed. */
  onRetry?: () => void;
  openButtonRef?: Ref<HTMLButtonElement>;
  retryButtonRef?: Ref<HTMLButtonElement>;
  isCutting: boolean;
  /** A press landed on the tear line and hasn't gone across yet: light the line under it. */
  pressing?: boolean;
  isPackCut: boolean;
  /** The pack is torn but its ticket is still being worked out (a slow phone). */
  waiting?: boolean;
  /** A press just missed the tear line: show where to swipe. */
  nudging?: boolean;
  /** A tap on the tear line didn't swipe: the swipe hint pulses to show how. */
  tapped?: boolean;
  cutPoints: CutPoint[];
  sparks: readonly Spark[];
}

const PackCuttingUI = ({
  packRef,
  packDesign,
  set,
  refusal = null,
  onOpen,
  onRetry,
  openButtonRef,
  retryButtonRef,
  isCutting,
  pressing = false,
  isPackCut,
  waiting = false,
  nudging = false,
  tapped = false,
  cutPoints,
  sparks,
}: PackCuttingUIProps) => {
  const touch = useCoarsePointer();
  // The torn pack flies off over the first card (#312 P2-6), so it drops its controls the moment it
  // starts leaving: a focused Open pack button there would keep focus from the card, which takes it
  // only from the page, and would still be read and queried for the exit's quarter second.
  const leaving = !useIsPresent();

  return (
    <>
      <div className="pack-shell-wrap" inert={leaving || undefined}>
        {/* A gesture surface only: the Open pack button under it is the control for keys and screen readers. */}
        <div
          ref={packRef}
          className={`pack-shell ${isCutting ? 'is-cutting' : ''} ${pressing && !isCutting ? 'is-pressed' : ''} ${isPackCut ? 'is-cut' : ''} ${nudging && !isCutting && !pressing ? 'is-nudged' : ''} ${tapped && !isCutting && !pressing ? 'is-tapped' : ''}`}
          style={{ '--pack-mask': `url("${packDesign}")` } as React.CSSProperties}
        >
          {/* Each half carries its foil with it when the wrapper tears. */}
          <div className="pack-half pack-half-bottom">
            <img src={packDesign} alt="Brainrot TCG booster pack wrapper" draggable="false" />
          </div>
          <div className="pack-half pack-half-top" aria-hidden="true">
            <img src={packDesign} alt="" draggable="false" />
          </div>
          {/* The set tag is stuck on the top strip, so it tears away with it. */}
          <div className="pack-top-piece">
            <div
              className="pack-set-ribbon"
              style={{ '--set-a': set.palette?.[0] ?? '#ff3df2', '--set-b': set.palette?.[1] ?? '#29f0ff' } as React.CSSProperties}
            >
              <span className="pack-set-name">{set.name}</span>
              <span className="pack-set-era">{set.era}</span>
            </div>
          </div>
          <div className="tear-guide" />
          {/* Only while there is a pack left to tear. */}
          {!isPackCut && (
            <div className="swipe-hint">
              <MoveHorizontal className="swipe-hint-icon" aria-hidden="true" />
              <span className="swipe-hint-text">
                {nudging ? (touch ? 'Swipe along the dotted line' : 'Drag along the dotted line') : touch ? 'Swipe across to open' : 'Drag across to open'}
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
          <div className="spark-layer" aria-hidden="true" style={{ '--spark-life': `${SPARK_LIFETIME_MS}ms` } as React.CSSProperties}>
            {sparks.map((spark) => (
              <span
                key={spark.id}
                className="drag-spark"
                style={{
                  '--x': `${spark.x}px`,
                  '--y': `${spark.y}px`,
                  '--dx': `${spark.dx}px`,
                  '--dy': `${spark.dy}px`,
                  '--size': `${spark.size}px`,
                  '--hue': spark.hue,
                } as React.CSSProperties}
              />
            ))}
          </div>
        </div>
        {/* Seen, not read: the pack's live region (PackOpener) says it once. The button under the pack already says Opening…, so this says why it is taking a while. */}
        {waiting && !refusal && !leaving && (
          <p className="pack-hint is-waiting" aria-hidden="true">
            Taking a moment…
          </p>
        )}
      </div>
      {/* Under the tear line: the swipe is the show, this is the same opening for everyone else (#312). */}
      <div className="pack-actions">
        {leaving ? null : refusal ? (
          <div className="pack-refusal">
            <p className="pack-refusal-text">{REFUSAL_COPY[refusal].message}</p>
            <button type="button" ref={retryButtonRef} className="btn btn--primary btn--sm pack-retry-button quiet-focus" onClick={onRetry}>
              {REFUSAL_COPY[refusal].action}
            </button>
          </div>
        ) : (
          // Stays mounted (and focused) through the tear, so focus has somewhere to be until the first card takes it.
          <button
            type="button"
            ref={openButtonRef}
            className="btn btn--secondary btn--sm pack-open-button quiet-focus"
            onClick={onOpen}
            aria-disabled={isPackCut || undefined}
          >
            {isPackCut ? 'Opening…' : 'Open pack'}
          </button>
        )}
      </div>
    </>
  );
};

export default PackCuttingUI;
