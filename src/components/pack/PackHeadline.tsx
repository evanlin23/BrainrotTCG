import type { Ref } from 'react';
import { packHeadline } from '../../engine';
import { FINISH_INFO } from '../../game/modifiers';
import type { CardWithMeta } from '../cards/Card';
import '../../styles/PackHeadline.css';

interface PackHeadlineProps {
  cards: readonly CardWithMeta[];
  /** The results screen: the total is its heading, focused as it appears. */
  headingRef?: Ref<HTMLHeadingElement>;
  className?: string;
}

/** "[finish] [Holo] [Misprint] [name]", absent modifiers left out. */
const standoutName = (card: CardWithMeta) =>
  [card.finish && FINISH_INFO[card.finish].name, card.isHolo && 'Holo', card.misprint && 'Misprint', card.name].filter(Boolean).join(' ');

/**
 * A pack's headline (docs/DESIGN.md, pull headline rule): its total, its combo and multiplier, then
 * its standout card with that card's own points (no pack multiplier). Display only: the numbers come
 * from the engine's scoring, never a second scorer.
 */
const PackHeadline = ({ cards, headingRef, className = '' }: PackHeadlineProps) => {
  const { total, combo, standout } = packHeadline(cards.map((card) => ({ ...card, cardId: card.key, card })));
  const totalText = <>Pack total: <span className="tabular">{total.toLocaleString()}</span></>;
  return (
    <div className={`pack-headline ${className}`}>
      {headingRef ? (
        <h2 className="summary-title pack-headline-total" ref={headingRef} tabIndex={-1}>{totalText}</h2>
      ) : (
        <p className="pack-headline-total">{totalText}</p>
      )}
      <p className="pack-headline-combo tabular">{combo.name} ×{combo.multiplier.toLocaleString()}</p>
      {standout && (
        <p className="pack-headline-standout">
          Standout card: <span className="pack-headline-card">{standoutName(standout.card.card)}</span>{' '}
          <span className="tabular">· {standout.points.toLocaleString()}</span>
          <span className="sr-only"> card points</span>
        </p>
      )}
    </div>
  );
};

export default PackHeadline;
