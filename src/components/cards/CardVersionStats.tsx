import type { Card } from '../../data/cards';
import { cardStats } from '../../game/cardStats';
import { modifierLabel } from '../../game/modifiers';
import type { CardVersion } from '../../game/versions';

/**
 * The shown version in words ("Gold · Holo · Misprint", nothing for a plain card), then its points
 * without any pack's multiplier and how often a pack has it.
 */
const CardVersionStats = ({ card, version }: { card: Card; version: CardVersion }) => {
  const label = modifierLabel(version);
  return (
    <>
      {label && <p className="card-viewer-version">{label}</p>}
      <p className="card-viewer-points tabular">{cardStats(card, version).line}</p>
    </>
  );
};

export default CardVersionStats;
