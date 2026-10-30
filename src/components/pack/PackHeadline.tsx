import type { ReactNode, Ref } from 'react';
import { Medal } from 'lucide-react';
import { packHeadline } from '../../engine';
import { newBestGain, type NewBest } from '../../game/personalRecords';
import type { CardWithMeta } from '../cards/Card';
import '../../styles/PackHeadline.css';

interface PackHeadlineProps {
  cards: readonly CardWithMeta[];
  /**
   * The results screen: "[n] Brainrot Score" is its heading, focused as it appears, and the combo
   * with its multiplier follows on one line. It shows no chance of a score: the score is the one number.
   */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Off where a score panel next to it already shows the total (the pack viewer). */
  showTotal?: boolean;
  /**
   * The results screen only: this pack strictly beat the player's best before it (personalRecords), so
   * the heading leads with NEW BEST and a line under the combo gives the previous best.
   */
  newBest?: NewBest | null;
  /** A last line, such as the results screen's Hall of Fame line. */
  children?: ReactNode;
  className?: string;
}

/**
 * A pack's headline (docs/DESIGN.md, pull headline rule). On the results screen: the Brainrot Score,
 * then the combo with its multiplier. Elsewhere: the total and the combo with its multiplier. Display
 * only: the numbers come from the engine's scoring, never a second scorer.
 */
const PackHeadline = ({ cards, headingRef, showTotal = true, newBest, children, className = '' }: PackHeadlineProps) => {
  const { total, combo } = packHeadline(cards.map((card) => ({ ...card, cardId: card.key, card })));
  const record = headingRef ? newBest : null;
  const gain = record ? newBestGain(record) : null;
  return (
    <div className={`pack-headline ${className}`}>
      {headingRef ? (
        <h2 className="summary-title pack-headline-heading" ref={headingRef} tabIndex={-1}>
          {record && (
            <span className="pack-headline-record">
              <Medal aria-hidden="true" />NEW BEST<span className="sr-only">:</span>
            </span>
          )}
          <span className="tabular">{total.toLocaleString()}</span> Brainrot Score
        </h2>
      ) : (
        showTotal && <p className="pack-headline-total">Pack total: <span className="tabular">{total.toLocaleString()}</span></p>
      )}
      <p className="pack-headline-combo tabular">{`${combo.name} ×${combo.multiplier.toLocaleString()}`}</p>
      {record && (
        <p className="pack-headline-previous tabular">
          {`previous best ${record.previous.toLocaleString()}${gain ? ` · ${gain}` : ''}`}
        </p>
      )}
      {children}
    </div>
  );
};

export default PackHeadline;
