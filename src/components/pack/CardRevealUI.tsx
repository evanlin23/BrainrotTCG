import { useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion, type PanInfo } from 'framer-motion';
import { FastForward } from 'lucide-react';
import Card from '../cards/Card';
import type { CardWithMeta } from '../cards/Card';
import cardBackImage from '../../assets/images/card_back.webp';
import RarityBadge from '../ui/RarityBadge';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { isBigPull, isSpecialReveal, SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';
import { cardPoints } from '../../engine';

const Motion = motion;

interface CardRevealUIProps {
  currentCard: CardWithMeta;
  cardBack?: string;
  currentIndex: number;
  totalCards: number;
  hasMovedMouse: boolean;
  onInteraction: () => void;
  /** Skip to the summary, pausing for valuable cards when the setting is enabled. */
  onSkip: () => void;
  /** Leave the presentation while retaining the already-spent pack. */
  onLeave?: () => void;
  /** A valuable card gets a moment to land before any input can move on. */
  revealLocked?: boolean;
  /** Visual celebration runs independently of the optional input lock. */
  celebrating?: boolean;
  skipping?: boolean;
}

/** How far (px) or how fast (px/s) a flipped card has to be flung to move on. */
const SWIPE_DISTANCE = 80;
const SWIPE_SPEED = 500;

/**
 * One card at a time off the top of the stack, rarest last. Big pulls light the back's edge before
 * the flip and get a spotlight after it; a flipped card can be swiped away or tapped.
 */
const CardRevealUI = ({ currentCard, cardBack, currentIndex, totalCards, hasMovedMouse, onInteraction, onSkip, onLeave, revealLocked = false, celebrating = false, skipping = false }: CardRevealUIProps) => {
  const touch = useCoarsePointer();
  const reducedMotion = useReducedMotion();
  const revealed = currentCard?.isRevealed;
  const remaining = totalCards - currentIndex - 1;
  const big = !!currentCard && isBigPull(currentCard);
  const special = !!currentCard && isSpecialReveal(currentCard);
  const celebration = celebrating && !!revealed && special;
  const slow = !!currentCard && !special && (currentCard.rarity === 'LEGENDARY' || currentCard.rarity === 'BRAINROT');
  const hint = revealLocked ? 'Big pull!' : touch
    ? revealed
      ? 'Swipe or tap for the next card'
      : 'Tap card to flip'
    : revealed
      ? 'Click or press Space for the next card'
      : 'Click or press Space to flip';

  // A mouse drag ends with a click on the card; that click isn't a tap, so it mustn't advance again.
  const draggedAt = useRef(0);
  const onDragEnd = (_: unknown, info: PanInfo) => {
    draggedAt.current = performance.now();
    if (revealLocked) return;
    if (Math.abs(info.offset.x) > SWIPE_DISTANCE || Math.abs(info.velocity.x) > SWIPE_SPEED) onInteraction();
  };
  const onTap = () => {
    if (!revealLocked && performance.now() - draggedAt.current > 300) onInteraction();
  };

  return (
    <>
      <div className="reveal-top">
        {onLeave && <button type="button" className="reveal-leave" onClick={onLeave}>Back to packs</button>}
        <div className="reveal-progress" role="progressbar" aria-label="Cards revealed" aria-valuemin={1} aria-valuemax={totalCards} aria-valuenow={currentIndex + 1} aria-valuetext={`Card ${currentIndex + 1} of ${totalCards}`}>
          {Array.from({ length: totalCards }, (_, i) => (
            <span key={i} className={i < currentIndex ? 'done' : i === currentIndex ? 'current' : ''} aria-hidden="true" />
          ))}
        </div>
        <button type="button" className="reveal-skip" title="Show the full pack summary; good-pull pauses still follow your settings." onClick={onSkip} disabled={revealLocked || skipping}>
          Skip opening animation <FastForward aria-hidden="true" />
        </button>
      </div>

      <div className={`active-card-container ${cardBack ? `back-${cardBack}` : ''} ${revealed && big ? 'is-spotlit' : ''}`} aria-busy={revealLocked} style={{ '--special-reveal-duration': `${SPECIAL_REVEAL_DURATION_MS}ms` } as React.CSSProperties}>
        {/* The cards still to come, as a stack behind the current one. */}
        {Array.from({ length: Math.min(remaining, 3) }, (_, i) => (
          <div key={`stack-${i}`} className="reveal-stack-card" style={{ '--depth': i + 1 } as React.CSSProperties} aria-hidden="true">
            <img src={cardBackImage} alt="" className="card-back-image" draggable="false" />
          </div>
        ))}
        <AnimatePresence mode="popLayout">
          {currentCard && (
            <Motion.div
              key={currentCard.uniqueId}
              className={`reveal-card ${celebration ? 'is-celebrating' : ''}`}
              initial={{ y: 24, opacity: 0, scale: 0.96 }}
              animate={{ y: 0, opacity: 1, scale: celebration && !reducedMotion ? [1, 1.055, 1.03] : revealed && big ? 1.03 : 1 }}
              exit={{ x: -360, opacity: 0, rotate: -10, transition: { duration: 0.22 } }}
              transition={{ duration: celebration ? SPECIAL_REVEAL_DURATION_MS / 1000 : 0.22, ease: 'easeOut' }}
              drag={revealed && !revealLocked ? 'x' : false}
              dragSnapToOrigin
              dragElastic={0.6}
              onDragEnd={onDragEnd}
            >
              <Card card={currentCard} isFlipped={currentCard.isRevealed} onFlip={onTap} tell={big} slowFlip={slow} />
            </Motion.div>
          )}
        </AnimatePresence>
        {celebration && currentCard && (
          <div key={currentCard.uniqueId} className="special-reveal-celebration" role="status">
            <div className="special-reveal-rays" aria-hidden="true" />
            <div className="special-reveal-banner">
              <span>Big pull!</span>
              <strong>{cardPoints(currentCard.rarity, currentCard.isHolo, currentCard.finish, currentCard.misprint).toLocaleString()} points</strong>
            </div>
          </div>
        )}
      </div>

      {/* Waits for the flip to land (longer for the slow Legendary and Brainrot flips), so it can't spoil it. */}
      <div className={`reveal-rarity ${slow ? 'is-slow' : ''}`} aria-live="polite">
        {revealed && <RarityBadge rarity={currentCard.rarity} isHolo={currentCard.isHolo} finish={currentCard.finish} misprint={currentCard.misprint} />}
        {revealed && currentCard.isNew && <span className="reveal-new">New</span>}
      </div>

      <p className="tip-text">{hint}</p>
      {!touch && <div className={`mouse-hint ${hasMovedMouse ? 'fade-out' : ''}`}>Move the mouse over the card to tilt it</div>}
    </>
  );
};

export default CardRevealUI;
