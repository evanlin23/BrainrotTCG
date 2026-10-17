import type { CSSProperties } from 'react';
import type { CardWithMeta } from '../cards/Card';
import { cardPoints } from '../../engine';
import { SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';

/**
 * A big pull's ribbon, shown in the pack's top bar above the card (never over its art) for as long
 * as the celebration runs. It is the pull's one screen-reader announcement. While the pull holds
 * the reveal (the "pause on big pulls" setting), keys do nothing for a moment; `holding` says so here,
 * in the same announcement, so a screen-reader player isn't left pressing a card that won't answer.
 */
const ShowcaseRibbon = ({ card, holding = false }: { card: CardWithMeta; holding?: boolean }) => (
  <div className="showcase-ribbon" role="status" style={{ '--special-reveal-duration': `${SPECIAL_REVEAL_DURATION_MS}ms` } as CSSProperties}>
    <span className="showcase-ribbon-kicker">Big pull!</span>{' '}
    <strong className="showcase-ribbon-points tabular">
      {cardPoints(card.rarity, card.isHolo, card.finish, card.misprint).toLocaleString()} points
    </strong>
    {holding && <span className="sr-only">. Continue in a moment.</span>}
  </div>
);

export default ShowcaseRibbon;
