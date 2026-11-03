import type { Ref } from 'react';
import type { CardWithMeta } from '../cards/Card';
import type { PackTakeoverReason } from '../../game/packTakeover';
import type { StageClickGuard } from '../../hooks/useStageClickGuard';
import TakeoverBanner from './TakeoverBanner';
import TakeoverOverlay from './TakeoverOverlay';
import '../../styles/TakeoverReveal.css';

interface PackTakeoverProps {
  /** The pack's best card: its art fills the screen, as a card's does in the reveal's takeover. */
  card: CardWithMeta;
  reason: PackTakeoverReason;
  /** The banner's second line: the set. */
  name: string;
  /** Ends the takeover (a tap anywhere, Space, Enter or Skip). The summary's own timer ends it too. */
  onSettle: () => void;
  /** The summary's settle window: a tap meant for the last card never skips the moment it opens. */
  guard: StageClickGuard;
  skipRef?: Ref<HTMLButtonElement>;
}

/**
 * The pack-level takeover (#1293 c), over the summary as it opens: the best card's art full-bleed, a banner
 * saying why (the hand, or a new best), and Skip. It is the card takeover's overlay and banner with the whole
 * screen for a button, so a tap anywhere settles it, and nothing is held: the "Pause on good pulls" setting
 * names cards, not packs. The pack's X stays above it (z-hud), and the summary under it is inert until it settles.
 */
const PackTakeover = ({ card, reason, name, onSettle, guard, skipRef }: PackTakeoverProps) => (
  <div className="pack-takeover" data-reason={reason} onClickCapture={guard.blockClicks}>
    <TakeoverOverlay card={card} reason={reason} />
    <div className="pack-takeover-banner">
      <TakeoverBanner reason={reason} name={name} />
    </div>
    <button type="button" className="pack-takeover-skip" ref={skipRef} onClick={onSettle}>
      <span className="pack-takeover-skip-label">Skip</span>
    </button>
  </div>
);

export default PackTakeover;
