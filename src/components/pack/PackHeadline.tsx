import type { ReactNode, Ref } from 'react';
import { packHeadline } from '../../engine';
import { FINISH_INFO } from '../../game/modifiers';
import type { CardWithMeta } from '../cards/Card';
import '../../styles/PackHeadline.css';

interface PackHeadlineProps {
  cards: readonly CardWithMeta[];
  /**
   * The results screen: the combo and the total, as "[n] Brainrot Score", are its heading, focused as
   * it appears.
   */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Results screen only: how rare the combo is in this set, a line under the standout card. */
  oneIn?: number | null;
  /** Off where a score panel next to it already shows the total (the pack viewer). */
  showTotal?: boolean;
  /** A last line, such as the results screen's Hall of Fame line. */
  children?: ReactNode;
  className?: string;
}

const formatOneIn = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString());

/** "[finish] [Holo] [Misprint] [name]", absent modifiers left out. */
const standoutName = (card: CardWithMeta) =>
  [card.finish && FINISH_INFO[card.finish].name, card.isHolo && 'Holo', card.misprint && 'Misprint', card.name].filter(Boolean).join(' ');

/**
 * A pack's headline (docs/DESIGN.md, pull headline rule): its total, its combo and multiplier, then
 * its standout card with that card's own points (no pack multiplier). Display only: the numbers come
 * from the engine's scoring, never a second scorer.
 */
const PackHeadline = ({ cards, headingRef, oneIn, showTotal = true, children, className = '' }: PackHeadlineProps) => {
  const { total, combo, standout } = packHeadline(cards.map((card) => ({ ...card, cardId: card.key, card })));
  const comboText = `${combo.name} ×${combo.multiplier.toLocaleString()}`;
  return (
    <div className={`pack-headline ${className}`}>
      {headingRef ? (
        <h2 className="summary-title pack-headline-heading" ref={headingRef} tabIndex={-1}>
          <span className="pack-headline-combo tabular">{comboText}</span>
          <span className="sr-only">, </span>
          <span className="pack-headline-total">
            <span className="tabular">{total.toLocaleString()}</span> Brainrot Score
          </span>
        </h2>
      ) : (
        <>
          {showTotal && <p className="pack-headline-total">Pack total: <span className="tabular">{total.toLocaleString()}</span></p>}
          <p className="pack-headline-combo tabular">{comboText}</p>
        </>
      )}
      {standout && (
        <p className="pack-headline-standout">
          Standout card: <span className="pack-headline-card">{standoutName(standout.card.card)}</span>{' '}
          <span className="tabular">· {standout.points.toLocaleString()}</span>
          <span className="sr-only"> card points</span>
        </p>
      )}
      {oneIn != null && (
        <p className="pack-headline-odds tabular">
          {combo.name}: about 1 in {formatOneIn(oneIn)} packs
        </p>
      )}
      {children}
    </div>
  );
};

export default PackHeadline;
