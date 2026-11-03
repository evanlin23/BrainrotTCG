import type { CSSProperties } from 'react';
import { TAKEOVER_DURATION_MS, TAKEOVER_KICKER, type TakeoverReason } from '../../game/reveal';
import '../../styles/TakeoverReveal.css';

/**
 * A takeover's name banner, in the pack's top bar above the card (never over its art) for as long as the
 * takeover runs: what happened (Collection complete, Set complete, Brainrot) and the name it happened to.
 * It is the takeover's one screen-reader announcement. While the pull holds the reveal (the "pause on
 * good pulls" setting), keys do nothing for a moment; `holding` says so in the same announcement.
 * Long names are cut short on screen only: the whole name is in the text a screen reader reads.
 */
const TakeoverBanner = ({ reason, name, holding = false }: { reason: TakeoverReason; name: string; holding?: boolean }) => (
  <div className="takeover-banner" role="status" data-reason={reason} style={{ '--takeover-duration': `${TAKEOVER_DURATION_MS}ms` } as CSSProperties}>
    <span className="takeover-banner-kicker">{TAKEOVER_KICKER[reason]}</span>
    <span className="sr-only">. </span>
    <strong className="takeover-banner-name">{name}</strong>
    {holding && <span className="sr-only">. Continue in a moment.</span>}
  </div>
);

export default TakeoverBanner;
