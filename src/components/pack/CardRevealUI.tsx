import { Fragment, useCallback, useEffect, useRef, type ComponentPropsWithRef } from 'react';
import { motion, AnimatePresence, useIsPresent, type PanInfo } from 'framer-motion';
import { FastForward } from 'lucide-react';
import Card from '../cards/Card';
import type { CardWithMeta } from '../cards/Card';
import { cardFaceLabel } from '../cards/cardLabel';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import cardBackImage from '../../assets/images/card_back.webp';
import RarityBadge from '../ui/RarityBadge';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { isBigPull, isSpecialReveal, SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';
import { siteLabel } from '../../game/pulls';
import { cardNumber } from '../../data/cards';

const Motion = motion;

/** The site's address, with a break allowed after each slash: Chrome won't break an address there by itself (#472). */
const SiteAddress = () => {
  const pieces = siteLabel().split('/');
  return pieces.map((piece, i) => (
    <Fragment key={i}>{piece}{i < pieces.length - 1 && <>/<wbr /></>}</Fragment>
  ));
};

/**
 * The card on top, a real button: Space or Enter, a click or a tap flips it, then moves on. One leaving
 * keeps its last props for its exit, so it is inert until it has gone: out of the Tab order and the
 * accessibility tree. Not aria-hidden too, since it can still hold focus for a moment, until the next
 * card takes it, and Chrome blocks aria-hidden over a focused element.
 */
const RevealCard = (props: ComponentPropsWithRef<typeof Motion.button>) => {
  const present = useIsPresent();
  return <Motion.button type="button" {...props} inert={!present || undefined} />;
};

interface CardRevealUIProps {
  currentCard: CardWithMeta;
  cardBack?: string;
  currentIndex: number;
  totalCards: number;
  hasMovedMouse: boolean;
  onInteraction: () => void;
  /** Skip to the summary, pausing for valuable cards when the setting is enabled. */
  onSkip: () => void;
  /** A valuable card gets a moment to land before any input can move on. */
  revealLocked?: boolean;
  /** Visual celebration runs independently of the optional input lock. */
  celebrating?: boolean;
  skipping?: boolean;
  /** The pack's set, named in the provenance line under the card. */
  setName?: string;
}

/** How far (px) or how fast (px/s) a flipped card has to be flung to move on. */
const SWIPE_DISTANCE = 80;
const SWIPE_SPEED = 500;

/**
 * One card at a time off the top of the stack, rarest last. Big pulls light the back's edge before
 * the flip and get a spotlight after it; a flipped card can be swiped away or tapped.
 */
const CardRevealUI = ({ currentCard, cardBack, currentIndex, totalCards, hasMovedMouse, onInteraction, onSkip, revealLocked = false, celebrating = false, skipping = false, setName }: CardRevealUIProps) => {
  const touch = useCoarsePointer();
  const reducedMotion = usePrefersReducedMotion();
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

  // A mouse drag ends with a click on the card it dragged; that click isn't a tap, so it mustn't advance
  // again. Only that card's click: a swipe deals the next card at once, and a tap on it is a real tap.
  const dragged = useRef<{ id?: CardWithMeta['uniqueId']; at: number }>({ at: 0 });
  const onDragEnd = (_: unknown, info: PanInfo) => {
    dragged.current = { id: currentCard?.uniqueId, at: performance.now() };
    if (revealLocked) return;
    if (Math.abs(info.offset.x) > SWIPE_DISTANCE || Math.abs(info.velocity.x) > SWIPE_SPEED) onInteraction();
  };
  const onTap = () => {
    const justDragged = dragged.current.id === currentCard?.uniqueId && performance.now() - dragged.current.at <= 300;
    if (!revealLocked && !justDragged) onInteraction();
  };

  // A sideways flick on the card is the card's own gesture, never the page's. The card lets the page pan
  // only up and down (touch-action: pan-y), but Chromium still starts a fling from a sideways flick and
  // then eats the next tap as the one that stops it: no click, so a tap on the card right after a flick
  // did nothing (#504). Cancelling the sideways touchmoves keeps the flick from becoming a scroll at all.
  // The swipe itself runs on pointer events, which this leaves alone; up and down still scroll the page,
  // and two fingers still zoom. React's touch listeners are passive, so this one is the DOM's own.
  const stageEl = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const stage = stageEl.current;
    if (!stage) return;
    let start: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      start = touch && (event.target as Element).closest('.reveal-card') ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      if (!start || !touch || !event.cancelable) return;
      if (Math.abs(touch.clientX - start.x) > Math.abs(touch.clientY - start.y)) event.preventDefault();
    };
    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      stage.removeEventListener('touchstart', onTouchStart);
      stage.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  // The card is the reveal's button for the keyboard too: Space or Enter flips it, then moves on
  // (useKeyboardControls, which holds Space down to repeat). Each card is a new element, so focus follows
  // from the card leaving, or from the pack after the tear. The card leaving unmounts after the new one
  // mounts, so its null is ignored.
  const cardEl = useRef<HTMLButtonElement | null>(null);
  const cardRef = useCallback((el: HTMLButtonElement | null) => {
    if (el) cardEl.current = el;
  }, []);
  const cardId = currentCard?.uniqueId;
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('.reveal-card')) cardEl.current?.focus({ preventScroll: true });
  }, [cardId]);
  // Face down it is only its place in the pack, so the name can't spoil the flip. Face up it carries the
  // card and its rarity, which the art shows by colour alone (the live region says it once, as it lands).
  const cardLabel = !revealed
    ? `Flip card ${currentIndex + 1} of ${totalCards}`
    : `${remaining > 0 ? 'Next card' : 'See the pack summary'}. Card ${currentIndex + 1} of ${totalCards}: ${cardFaceLabel(currentCard)}`;

  return (
    <>
      {/* The way out and the card count are in the pack's top bar (PackTopBar), the same on every stage. */}
      <div ref={stageEl} className={`active-card-container ${cardBack ? `back-${cardBack}` : ''} ${revealed && big ? 'is-spotlit' : ''}`} aria-busy={revealLocked} style={{ '--special-reveal-duration': `${SPECIAL_REVEAL_DURATION_MS}ms` } as React.CSSProperties}>
        {/* The cards still to come, as a stack behind the current one. */}
        {Array.from({ length: Math.min(remaining, 3) }, (_, i) => (
          <div key={`stack-${i}`} className="reveal-stack-card" style={{ '--depth': i + 1 } as React.CSSProperties} aria-hidden="true">
            <img src={cardBackImage} alt="" className="card-back-image" draggable="false" />
          </div>
        ))}
        <AnimatePresence mode="popLayout">
          {currentCard && (
            <RevealCard
              key={currentCard.uniqueId}
              className={`reveal-card quiet-focus ${celebration ? 'is-celebrating' : ''}`}
              ref={cardRef}
              data-pack-keys
              onClick={onTap}
              aria-label={cardLabel}
              aria-disabled={revealLocked || undefined}
              initial={{ y: 24, opacity: 0, scale: 0.96 }}
              animate={{ y: 0, opacity: 1, scale: celebration && !reducedMotion ? [1, 1.055, 1.03] : revealed && big ? 1.03 : 1 }}
              exit={{ x: -360, opacity: 0, rotate: -10, transition: { duration: 0.22 } }}
              transition={{ duration: celebration ? SPECIAL_REVEAL_DURATION_MS / 1000 : 0.22, ease: 'easeOut' }}
              drag={revealed && !revealLocked ? 'x' : false}
              dragSnapToOrigin
              dragElastic={0.6}
              onDragEnd={onDragEnd}
            >
              {/* The halo glows behind the card (it paints under it), so the art stays clear for a screenshot.
                  The pull is announced once, by the ribbon in the top bar (PackOpener's ShowcaseRibbon). */}
              {celebration && <div className="showcase-halo" aria-hidden="true" />}
              <Card card={currentCard} isFlipped={currentCard.isRevealed} tell={big} slowFlip={slow} />
            </RevealCard>
          )}
        </AnimatePresence>
      </div>

      {/* Waits for the flip to land (longer for the slow Legendary and Brainrot flips), so it can't spoil it. */}
      {/* Seen, not read: the pack's live region (PackOpener) says the card, its rarity and its stickers once. */}
      <div className={`reveal-rarity ${slow ? 'is-slow' : ''}`} aria-hidden="true">
        {revealed && <RarityBadge rarity={currentCard.rarity} isHolo={currentCard.isHolo} finish={currentCard.finish} misprint={currentCard.misprint} />}
        {revealed && currentCard.isNew && <span className="reveal-new">New</span>}
      </div>
      {/* Where this card is from, as a screenshot would show it. Its number waits for the flip like the
          badge, but holds its space so nothing moves between cards. Three parts (game, site, set and number)
          that a narrow phone wraps after a dot; only a part wider than the whole line breaks inside (#472). */}
      {currentCard && (
        <p className="reveal-provenance" aria-hidden="true">
          <span className="reveal-provenance-part"><span className="reveal-provenance-mark">Brainrot TCG</span> ·</span>{' '}
          <span className="reveal-provenance-part reveal-provenance-site"><SiteAddress /> ·</span>{' '}
          <span className="reveal-provenance-part reveal-provenance-set">
            {setName ?? currentCard.setId}{' '}
            <span className={`reveal-provenance-number tabular ${revealed ? 'is-shown' : ''} ${slow ? 'is-slow' : ''}`}>{cardNumber(currentCard)}</span>
          </span>
        </p>
      )}

      <p className="tip-text">{hint}</p>
      {/* Skip sits apart from the X, at the bottom, so a press meant for one can't land on the other. */}
      <div className="reveal-bottom">
        <button type="button" className="reveal-skip" title="Show the full pack summary; good-pull pauses still follow your settings." onClick={onSkip} disabled={revealLocked || skipping}>
          Skip opening animation <FastForward aria-hidden="true" />
        </button>
      </div>
      {!touch && !reducedMotion && <div className={`mouse-hint ${hasMovedMouse ? 'fade-out' : ''}`}>Move the mouse over the card to tilt it</div>}
    </>
  );
};

export default CardRevealUI;
