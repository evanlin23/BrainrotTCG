import { CARD_RARITIES, type Card } from '../../data/cards';
import { cardStats } from '../../game/cardStats';
import { modifierLabel } from '../../game/modifiers';
import type { CardVersion } from '../../game/versions';
import '../../styles/Scoring.css';

/**
 * The shown version as one line of words ("Gold · Holo · Misprint · Epic", or just "Epic" for a plain
 * copy), then its points without any pack's multiplier and how often a pack has it. The rarity keeps its
 * name and gem next to its colour, never colour alone.
 */
const CardVersionStats = ({ card, version }: { card: Card; version: CardVersion }) => {
  const rarity = CARD_RARITIES[card.rarity];
  const identity = [modifierLabel(version), rarity.name].filter(Boolean).join(' · ');
  return (
    <>
      <p className={`card-viewer-version rarity-pill ${card.rarity.toLowerCase()}`}>
        <span className="rarity-pill-gem" aria-hidden="true">{rarity.symbol}</span>
        <span className="card-viewer-identity">{identity}{version.uncertain ? ' (uncertain)' : ''}</span>
      </p>
      <p className="card-viewer-points tabular">{cardStats(card, version).line}</p>
    </>
  );
};

export default CardVersionStats;
