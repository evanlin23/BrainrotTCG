import { RefObject } from 'react';
import type { CutPoint } from '../../hooks/usePackCutter';
import type { Spark } from '../../hooks/useSparks';

interface PackCuttingUIProps {
  packRef: RefObject<HTMLDivElement>;
  packDesign: string;
  isCutting: boolean;
  isPackCut: boolean;
  cutPoints: CutPoint[];
  sparks: Spark[];
}

const PackCuttingUI = ({
  packRef,
  packDesign,
  isCutting,
  isPackCut,
  cutPoints,
  sparks,
}: PackCuttingUIProps) => {
  return (
    <>
      <div className="pack-shell-wrap">
        <div
          ref={packRef}
          className={`pack-shell ${isCutting ? 'is-cutting' : ''} ${isPackCut ? 'is-cut' : ''}`}
        >
          <img
            className="pack-half pack-half-bottom"
            src={packDesign}
            alt="Brainrot TCG booster pack wrapper"
            draggable="false"
          />
          <img
            className="pack-half pack-half-top"
            src={packDesign}
            alt=""
            aria-hidden="true"
            draggable="false"
          />
          <div className="tear-guide" />
          <div className="swipe-hint">
            <span className="swipe-hint-icon">👆</span>
            <span className="swipe-hint-text">Swipe to open</span>
          </div>
          {cutPoints.length > 1 && (
            <svg className="cut-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polyline
                className="cut-line"
                points={cutPoints.map(p => `${p.x},${p.y}`).join(' ')}
              />
            </svg>
          )}
        </div>
        <p className="pack-hint">nothing to see here!</p>
      </div>
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
    </>
  );
};

export default PackCuttingUI;
