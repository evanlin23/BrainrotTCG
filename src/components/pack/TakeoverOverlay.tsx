import type { CSSProperties } from 'react';
import type { CardWithMeta } from '../cards/Card';
import { isApprovedCardArt } from '../../game/cardArt';
import { TAKEOVER_DURATION_MS, type TakeoverReason } from '../../game/reveal';
import type { PackTakeoverReason } from '../../game/packTakeover';
import '../../styles/TakeoverReveal.css';

/**
 * The full-bleed half of a takeover: the card's art fills the screen behind the reveal, with rays and a
 * vignette. It is decoration only (hidden from screen readers, takes no press, paints behind every
 * control), so the card stays the reveal's button and nothing is covered. TakeoverBanner says what happened.
 * Under reduced motion it is the same picture standing still (TakeoverReveal.css).
 */
const TakeoverOverlay = ({ card, reason }: { card: CardWithMeta; reason: TakeoverReason | PackTakeoverReason }) => (
  <div className="takeover-overlay" data-reason={reason} aria-hidden="true" style={{ '--takeover-duration': `${TAKEOVER_DURATION_MS}ms` } as CSSProperties}>
    {isApprovedCardArt(card.image) && <img className="takeover-art" src={card.image} alt="" draggable="false" />}
    <div className="takeover-rays" />
    <div className="takeover-vignette" />
  </div>
);

export default TakeoverOverlay;
