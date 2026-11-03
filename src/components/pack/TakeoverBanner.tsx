import type { CSSProperties } from 'react';
import { TAKEOVER_DURATION_MS, TAKEOVER_KICKER, type TakeoverReason } from '../../game/reveal';
import { PACK_TAKEOVER_KICKER, type PackTakeoverReason } from '../../game/packTakeover';
import '../../styles/TakeoverReveal.css';

/**
 * A takeover's name banner, in the pack's top bar above the card (never over its art) for as long as the
 * takeover runs: what happened (Collection complete, Set complete, Brainrot) and the name it happened to.
 * It is the takeover's one screen-reader announcement. While the pull holds the reveal (the "pause on
 * good pulls" setting), keys do nothing for a moment; `holding` says so in the same announcement.
 * The pack-level takeover (PackTakeover) uses it too, with a hand or "New best" and the set's name.
 * Long names are cut short on screen only: the whole name is in the text a screen reader reads.
 */
const KICKER: Record<TakeoverReason | PackTakeoverReason, string> = { ...TAKEOVER_KICKER, ...PACK_TAKEOVER_KICKER };

const TakeoverBanner = ({ reason, name, holding = false }: { reason: TakeoverReason | PackTakeoverReason; name: string; holding?: boolean }) => (
  <div className="takeover-banner" role="status" data-reason={reason} style={{ '--takeover-duration': `${TAKEOVER_DURATION_MS}ms` } as CSSProperties}>
    <span className="takeover-banner-kicker">{KICKER[reason]}</span>
    <span className="sr-only">. </span>
    <strong className="takeover-banner-name">{name}</strong>
    {holding && <span className="sr-only">. Continue in a moment.</span>}
  </div>
);

export default TakeoverBanner;
