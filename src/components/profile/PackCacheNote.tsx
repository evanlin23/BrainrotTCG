import type { ReactNode } from 'react';
import { hydrateMyPacks, myPackCacheState } from '../../game/profiles';
import { usePackCacheVersion } from '../../hooks/usePackCache';

interface PackCacheNoteProps {
  /** What isn't shown yet, e.g. "your level and stats". */
  what: string;
  className?: string;
  /** More to offer when reading failed (e.g. re-opening the packs). */
  onFailed?: ReactNode;
}

/**
 * Saved packs still being read on this device (game/profiles.ts, hydrateMyPacks), or a read that
 * failed. Shown instead of stats that would leave them out: progress never reads as zero.
 */
export default function PackCacheNote({ what, className = 'pulls-note', onFailed }: PackCacheNoteProps) {
  usePackCacheVersion();
  if (myPackCacheState() === 'failed') {
    return (
      <p className={className} role="alert">
        Couldn't read your saved packs on this device just now, so {what} can't be shown yet.{' '}
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => void hydrateMyPacks()}>
          Try again
        </button>
        {onFailed && ' '}
        {onFailed}
      </p>
    );
  }
  return (
    <p className={className} role="status">
      Reading your saved packs… {what[0].toUpperCase() + what.slice(1)} will show once they're in.
    </p>
  );
}
