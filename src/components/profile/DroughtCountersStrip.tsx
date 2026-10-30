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

  const streaks = [stats.brainrot, stats.legendaryPlus, stats.epicPlus, stats.rankingsQualifier];
  // The markers formatDroughtStreak gives: "+" a lower bound, "*" none in any recorded pack.
  const hasLowerBound = streaks.some((s) => s.isBoundedByIncompleteHistory);
  const hasNoneFound = streaks.some((s) => !s.isBoundedByIncompleteHistory && !s.foundInHistory);

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
          <dt style={{ color: RARITY_COLORS.BRAINROT }}>Brainrot</dt>
          <dd className="tabular" aria-label={formatDroughtAccessible(stats.brainrot, 'Brainrot')}>
            {formatDroughtStreak(stats.brainrot)}
          </dd>
        </div>
        <div>
          <dt style={{ color: RARITY_COLORS.LEGENDARY }}>Legendary+</dt>
          <dd
            className="tabular"
            aria-label={formatDroughtAccessible(stats.legendaryPlus, 'Legendary or better')}
          >
            {formatDroughtStreak(stats.legendaryPlus)}
          </dd>
        </div>
        <div>
          <dt style={{ color: RARITY_COLORS.EPIC }}>Epic+</dt>
          <dd
            className="tabular"
            aria-label={formatDroughtAccessible(stats.epicPlus, 'Epic or better')}
          >
            {formatDroughtStreak(stats.epicPlus)}
          </dd>
        </div>
        <div>
          <dt>Rankings</dt>
          <dd
            className="tabular"
            aria-label={formatDroughtAccessible(stats.rankingsQualifier, 'Rankings qualifier')}
          >
            {formatDroughtStreak(stats.rankingsQualifier)}
          </dd>
        </div>
      </dl>

      <p className="profile-footnote">
        Counts this player's packs recorded on this device, from every set, each ticket once.
      </p>
      {hasLowerBound && (
        <p className="profile-footnote">
          + At least this many: an older pack's cards aren't saved on this device, or it is from a set
          this version of the game doesn't know.
        </p>
      )}
      {hasNoneFound && (
        <p className="profile-footnote">* None pulled in any pack recorded here.</p>
      )}
    </section>
  );
};

export default DroughtCountersStrip;
