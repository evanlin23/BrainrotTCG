import type { CSSProperties } from 'react';
import type { CardWithMeta } from '../cards/Card';
import { cardPoints } from '../../engine';
import { SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';

/**
 * A big pull's ribbon, shown in the pack's top bar above the card (never over its art) for as long
 * as the celebration runs. It is the pull's one screen-reader announcement.
 */
const ShowcaseRibbon = ({ card }: { card: CardWithMeta }) => (
  <div className="showcase-ribbon" role="status" style={{ '--special-reveal-duration': `${SPECIAL_REVEAL_DURATION_MS}ms` } as CSSProperties}>
    <span className="showcase-ribbon-kicker">Big pull!</span>
    <strong className="showcase-ribbon-points tabular">
      {cardPoints(card.rarity, card.isHolo, card.finish, card.misprint).toLocaleString()} points
    </strong>
  </div>
);

export default ShowcaseRibbon;
