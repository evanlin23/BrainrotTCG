import type { ReactNode, Ref } from 'react';
import { packHeadline } from '../../engine';
import type { CardWithMeta } from '../cards/Card';
import '../../styles/PackHeadline.css';

interface PackHeadlineProps {
  cards: readonly CardWithMeta[];
  /**
   * The results screen: "[n] Brainrot Score" is its heading, focused as it appears, and the combo
   * follows on one line with how rare a score this high is (its multiplier is in the Card guide).
   */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Results screen only: the chance a pack of this set scores at least this much, on the combo's line. */
  scoreChance?: number | null;
  /** Off where a score panel next to it already shows the total (the pack viewer). */
  showTotal?: boolean;
  /** A last line, such as the results screen's Hall of Fame line. */
  children?: ReactNode;
  className?: string;
}

const formatOneIn = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString());

/** "1 in 13 packs score this high", or "Most packs score this high" for a better-than-even chance. */
const scoreOdds = (chance: number) =>
  chance > 0.5 ? 'Most packs score this high' : `1 in ${formatOneIn(1 / chance)} packs score this high`;

/**
 * A pack's headline (docs/DESIGN.md, pull headline rule). On the results screen: the Brainrot Score,
 * then the combo and how rare a score this high is. Elsewhere: the total and the combo with its multiplier. Display
 * only: the numbers come from the engine's scoring, never a second scorer.
 */
const PackHeadline = ({ cards, headingRef, scoreChance, showTotal = true, children, className = '' }: PackHeadlineProps) => {
  const { total, combo } = packHeadline(cards.map((card) => ({ ...card, cardId: card.key, card })));
  return (
    <div className={`pack-headline ${className}`}>
      {headingRef ? (
        <>
          <h2 className="summary-title pack-headline-heading" ref={headingRef} tabIndex={-1}>
            <span className="tabular">{total.toLocaleString()}</span> Brainrot Score
          </h2>
          <p className="pack-headline-odds tabular">
            {scoreChance ? `${combo.name} · ${scoreOdds(scoreChance)}` : combo.name}
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
