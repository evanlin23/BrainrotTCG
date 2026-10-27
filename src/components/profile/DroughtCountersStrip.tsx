import { RARITY_COLORS } from '../../styles/palette';
import {
  formatDroughtAccessible,
  formatDroughtStreak,
  type PullDroughtStats,
} from '../../game/droughtCounters';
import '../../styles/Profile.css';

interface DroughtCountersStripProps {
  stats: PullDroughtStats;
}

/**
 * Compact stats strip showing packs opened since the last pull of each top rarity
 * and last Rankings qualifier (#757).
 *
 * Descriptive and observational only; odds are independent on every pack (no pity system).
 */
const DroughtCountersStrip = ({ stats }: DroughtCountersStripProps) => {
  if (stats.totalPacks === 0) return null;

  const hasIncomplete =
    stats.brainrot.isBoundedByIncompleteHistory ||
    stats.legendaryPlus.isBoundedByIncompleteHistory ||
    stats.epicPlus.isBoundedByIncompleteHistory;

  return (
    <section className="profile-drought-section" aria-label="Packs since last pull">
      <div className="profile-drought-head">
        <span className="profile-drought-heading">Packs since last</span>
        <span
          className="profile-drought-badge"
          title="Every pack has independent odds. Drought counters are purely observational; no pity mechanics exist."
        >
          Independent odds
        </span>
      </div>

      <dl className="profile-drought-stats">
        <div>
          <dd className="tabular" aria-label={formatDroughtAccessible(stats.brainrot, 'Brainrot')}>
            {formatDroughtStreak(stats.brainrot)}
          </dd>
          <dt style={{ color: RARITY_COLORS.BRAINROT }}>Brainrot</dt>
        </div>
        <div>
          <dd
            className="tabular"
            aria-label={formatDroughtAccessible(stats.legendaryPlus, 'Legendary or better')}
          >
            {formatDroughtStreak(stats.legendaryPlus)}
          </dd>
          <dt style={{ color: RARITY_COLORS.LEGENDARY }}>Legendary+</dt>
        </div>
        <div>
          <dd
            className="tabular"
            aria-label={formatDroughtAccessible(stats.epicPlus, 'Epic or better')}
          >
            {formatDroughtStreak(stats.epicPlus)}
          </dd>
          <dt style={{ color: RARITY_COLORS.EPIC }}>Epic+</dt>
        </div>
        <div>
          <dd
            className="tabular"
            aria-label={formatDroughtAccessible(stats.rankingsQualifier, 'Rankings qualifier')}
          >
            {formatDroughtStreak(stats.rankingsQualifier)}
          </dd>
          <dt>Rankings</dt>
        </div>
      </dl>

      {hasIncomplete && (
        <p className="profile-footnote">
          * Older pack card details are not saved locally; count is bounded by available history.
        </p>
      )}
    </section>
  );
};

export default DroughtCountersStrip;
