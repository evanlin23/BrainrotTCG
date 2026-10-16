import type { Card } from '../../data/cards';
import { cardStats } from '../../game/cardStats';
import { modifierLabel } from '../../game/modifiers';
import type { CardVersion } from '../../game/versions';

/**
 * The shown version in words ("Gold · Holo · Misprint", or "Plain" as on the version chips), then its points
 * without any pack's multiplier and how often a pack has it.
 */
const CardVersionStats = ({ card, version }: { card: Card; version: CardVersion }) => {
  return (
    <>
      <p className="card-viewer-version">{modifierLabel(version) || 'Plain'}</p>
      <p className="card-viewer-points tabular">{cardStats(card, version).line}</p>
    </>
  );
};

export default CardVersionStats;
