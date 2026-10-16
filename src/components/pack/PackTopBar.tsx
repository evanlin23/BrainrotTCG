import { X } from 'lucide-react';

interface PackTopBarProps {
  /** Back to the packs screen: the same handler as browser Back and Escape. */
  onLeave: () => void;
  /** During the reveal: the card on screen (from 0) and how many the pack has. */
  progress?: { index: number; total: number };
}

/**
 * The one way out of a pack, on every stage from the tear to the summary. The X is never disabled:
 * leaving keeps whatever the pack has already spent (see PackOpener's leavePack).
 */
const PackTopBar = ({ onLeave, progress }: PackTopBarProps) => (
  <div className="pack-top-bar">
    <button type="button" className="icon-btn pack-close" aria-label="Back to packs" title="Back to packs" onClick={onLeave}>
      <X aria-hidden="true" />
    </button>
    {progress && (
      <div className="pack-top-progress">
        <span className="pack-top-count tabular" aria-hidden="true">
          Card {progress.index + 1} of {progress.total}
        </span>
        <div
          className="reveal-progress"
          role="progressbar"
          aria-label="Cards revealed"
          aria-valuemin={1}
          aria-valuemax={progress.total}
          aria-valuenow={progress.index + 1}
          aria-valuetext={`Card ${progress.index + 1} of ${progress.total}`}
        >
          {Array.from({ length: progress.total }, (_, i) => (
            <span key={i} className={i < progress.index ? 'done' : i === progress.index ? 'current' : ''} aria-hidden="true" />
          ))}
        </div>
      </div>
    )}
  </div>
);

export default PackTopBar;
