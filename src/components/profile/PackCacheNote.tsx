import { useRef, type ReactNode } from 'react';
import { hydrateMyPacks, myPackCacheState } from '../../game/packCache';
import { usePackCacheVersion } from '../../hooks/usePackCache';

interface PackCacheNoteProps {
  /** What isn't shown yet, e.g. "your level and stats". */
  what: string;
  className?: string;
  /** More to offer when reading failed (e.g. re-opening the packs). */
  onFailed?: ReactNode;
}

/**
 * Saved packs still being read on this device (game/packCache.ts, hydrateMyPacks), or a read that
 * failed. Shown instead of stats that would leave them out: progress never reads as zero.
 * The note itself stays mounted across both states and takes focus on "Try again", so focus isn't
 * dropped to the page when the button goes away while the read runs.
 */
export default function PackCacheNote({ what, className = 'pulls-note', onFailed }: PackCacheNoteProps) {
  usePackCacheVersion();
  const note = useRef<HTMLParagraphElement>(null);
  const failed = myPackCacheState() === 'failed';
  const retry = () => {
    note.current?.focus();
    void hydrateMyPacks();
  };
  return (
    <p ref={note} className={className} tabIndex={-1}>
      {failed ? (
        <span key="failed" role="alert">
          Couldn't read your saved packs on this device just now, so {what} can't be shown yet.{' '}
          <button type="button" className="btn btn--secondary btn--sm" onClick={retry}>
            Try again
          </button>
          {onFailed && ' '}
          {onFailed}
        </span>
      ) : (
        <span key="loading" role="status">
          Reading your saved packs… {what[0].toUpperCase() + what.slice(1)} will show once they're in.
        </span>
      )}
    </p>
  );
}
