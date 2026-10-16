import type { ReactNode, Ref } from 'react';
import { packHeadline } from '../../engine';
import type { CardWithMeta } from '../cards/Card';
import '../../styles/PackHeadline.css';

interface PackHeadlineProps {
  cards: readonly CardWithMeta[];
  /**
   * The results screen: "[n] Brainrot Score" is its heading, focused as it appears, and the combo
   * follows on one line with how rare it is (its multiplier is in "How this score works").
   */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Results screen only: how rare the combo is in this set, on the combo's line. */
  oneIn?: number | null;
  /** Off where a score panel next to it already shows the total (the pack viewer). */
  showTotal?: boolean;
  /** A last line, such as the results screen's Hall of Fame line. */
  children?: ReactNode;
  className?: string;
}

const formatOneIn = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString());

/**
 * A pack's headline (docs/DESIGN.md, pull headline rule). On the results screen: the Brainrot Score,
 * then the combo and how rare it is. Elsewhere: the total and the combo with its multiplier. Display
 * only: the numbers come from the engine's scoring, never a second scorer.
 */
const PackHeadline = ({ cards, headingRef, oneIn, showTotal = true, children, className = '' }: PackHeadlineProps) => {
  const { total, combo } = packHeadline(cards.map((card) => ({ ...card, cardId: card.key, card })));
  return (
    <div className={`pack-headline ${className}`}>
      {headingRef ? (
        <>
          <h2 className="summary-title pack-headline-heading" ref={headingRef} tabIndex={-1}>
            <span className="tabular">{total.toLocaleString()}</span> Brainrot Score
          </h2>
          <p className="pack-headline-odds tabular">
            {oneIn != null ? `${combo.name} · about 1 in ${formatOneIn(oneIn)} packs` : combo.name}
          </p>
        </>
      ) : (
        <>
          {showTotal && <p className="pack-headline-total">Pack total: <span className="tabular">{total.toLocaleString()}</span></p>}
          <p className="pack-headline-combo tabular">{`${combo.name} ×${combo.multiplier.toLocaleString()}`}</p>
        </>
      )}
      {children}
    </div>
  );
};

export default PackHeadline;
