import { MoveHorizontal } from 'lucide-react';
import { RefObject } from 'react';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import type { CutPoint } from '../../hooks/usePackCutter';
import type { Spark } from '../../hooks/useSparks';
import type { SetDefinition } from '../../engine';
import { seamBands } from './seamTrail';

interface PackCuttingUIProps {
  packRef: RefObject<HTMLDivElement | null>;
  packDesign: string;
  set: SetDefinition;
  error: string | null;
  isCutting: boolean;
  isPackCut: boolean;
  /** The pack can't be opened now (the app's banner says why). */
  blocked?: boolean;
  /** The pack is torn but its ticket is still being worked out (a slow phone). */
  waiting?: boolean;
  /** A press just missed the tear line: show where to swipe. */
  nudging?: boolean;
  cutPoints: CutPoint[];
  sparks: readonly Spark[];
}

const PackCuttingUI = ({
  packRef,
  packDesign,
  set,
  error,
  isCutting,
  isPackCut,
  blocked = false,
  waiting = false,
  nudging = false,
  cutPoints,
  sparks,
}: PackCuttingUIProps) => {
  const touch = useCoarsePointer();

  return (
    <>
      <div className="pack-shell-wrap">
        {/* Also a button for the keyboard: Enter or Space opens it, same as the swipe. */}
        <div
          ref={packRef}
          className={`pack-shell ${isCutting ? 'is-cutting' : ''} ${isPackCut ? 'is-cut' : ''} ${nudging && !isCutting ? 'is-nudged' : ''}`}
          style={{ '--pack-mask': `url("${packDesign}")` } as React.CSSProperties}
          role="button"
          tabIndex={isPackCut ? -1 : 0}
          aria-label={`Open a ${set.name} pack`}
          aria-disabled={blocked || undefined}
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
          <div className="swipe-hint">
            <MoveHorizontal className="swipe-hint-icon" aria-hidden="true" />
            <span className="swipe-hint-text">
              {nudging ? (touch ? 'Swipe along the dotted line' : 'Drag along the dotted line') : touch ? 'Swipe across to open' : 'Drag across to open'}
            </span>
          </div>
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
          <div className="spark-layer" aria-hidden="true">
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
        {error && (
          <p className="pack-hint is-error" role="alert">
            {error}
          </p>
        )}
        {waiting && !error && (
          <p className="pack-hint is-waiting" role="status">
            Opening…
          </p>
        )}
      </div>
    </>
  );
};

export default PackCuttingUI;
