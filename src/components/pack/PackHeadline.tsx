import type { ReactNode, Ref } from 'react';
import { Medal } from 'lucide-react';
import { packHeadline } from '../../engine';
import { getLatestSet } from '../../content/sets';
import { newBestGain, type PackRecord } from '../../game/personalRecords';
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
   * The results screen only: what this pack set (personalRecords' packRecord). A new all-time best leads
   * the heading with NEW BEST (a solid medal) and a set best with "Best in [set]" (an outlined medal),
   * each with the previous best under the combo; a #2 or #3 pack gets one quiet line there instead.
   */
  record?: PackRecord | null;
  /** A last line, such as the results screen's Hall of Fame line. */
  children?: ReactNode;
  className?: string;
}

/**
 * A pack's headline (docs/DESIGN.md, pull headline rule). On the results screen: the Brainrot Score,
 * then the combo with its multiplier. Elsewhere: the total and the combo with its multiplier. Display
 * only: the numbers come from the engine's scoring, never a second scorer.
 */
const PackHeadline = ({ cards, headingRef, showTotal = true, record: shown, children, className = '' }: PackHeadlineProps) => {
  const { total, combo } = packHeadline(cards.map((card) => ({ ...card, cardId: card.key, card })));
  const record = headingRef ? shown : null;
  const beat = record && record.kind !== 'top' ? record : null;
  const gain = beat ? newBestGain(beat) : null;
  return (
    <div className={`pack-headline ${className}`}>
      {headingRef ? (
        <h2 className="summary-title pack-headline-heading" ref={headingRef} tabIndex={-1}>
          {beat?.kind === 'best' && (
            <span className="pack-headline-record">
              <Medal aria-hidden="true" />NEW BEST<span className="sr-only">:</span>
            </span>
          )}
          {beat?.kind === 'set-best' && (
            <span className="pack-headline-record pack-headline-record--set">
              <Medal aria-hidden="true" />
              <span className="pack-headline-record-name">Best in {getLatestSet(beat.setId)?.name ?? beat.setId}</span>
              <span className="sr-only">:</span>
            </span>
          )}
          <span className="tabular">{total.toLocaleString()}</span> Brainrot Score
        </h2>
      ) : (
        showTotal && <p className="pack-headline-total">Pack total: <span className="tabular">{total.toLocaleString()}</span></p>
      )}
      <p className="pack-headline-combo tabular">{`${combo.name} ×${combo.multiplier.toLocaleString()}`}</p>
      {beat && (
        <p className="pack-headline-previous tabular">
          {`previous ${beat.kind === 'set-best' ? 'set best' : 'best'} ${beat.previous.toLocaleString()}${gain ? ` · ${gain}` : ''}`}
        </p>
      )}
      {record?.kind === 'top' && <p className="pack-headline-previous pack-headline-rank">{`your #${record.rank} pack ever`}</p>}
      {children}
    </div>
  );
};

export default PackHeadline;
