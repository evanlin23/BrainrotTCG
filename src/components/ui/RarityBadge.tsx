import { CARD_RARITIES, cardPoints, type RarityKey } from '../../data/cards';
import type { Finish } from '../../engine';
import { FINISH_INFO } from '../../game/modifiers';
import '../../styles/Scoring.css';

interface RarityBadgeProps {
  rarity: RarityKey;
  isHolo?: boolean;
  finish?: Finish | null;
  misprint?: boolean;
  showPoints?: boolean;
}

/**
 * Rarity shown by name and colour together (never colour alone), plus the card's points (modifiers included).
 * Flags are read as `!!flag`, like the save's readers, so an older stored value never renders as text (a 0).
 */
const RarityBadge = ({ rarity, isHolo: holo, finish, misprint: misprinted, showPoints = true }: RarityBadgeProps) => {
  const isHolo = !!holo;
  const misprint = !!misprinted;
  return (
    <span className={`rarity-pill ${rarity.toLowerCase()}`}>
      <span className="rarity-pill-gem" aria-hidden="true">{CARD_RARITIES[rarity].symbol}</span>
      {/* Same order as the card's sticker: finish, holo, misprint. */}
      <span>
        {finish && <span style={{ color: FINISH_INFO[finish].color }}>{FINISH_INFO[finish].name} </span>}
        {isHolo && 'Holo '}
        {misprint && 'Misprint '}
        {CARD_RARITIES[rarity].name}
      </span>
      {showPoints && <span className="rarity-pill-points">{cardPoints(rarity, isHolo, finish, misprint).toLocaleString()} pts</span>}
    </span>
  );
};

export default RarityBadge;
