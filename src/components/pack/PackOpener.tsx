import { useState, useCallback, useEffect, useRef, type SyntheticEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { CardWithMeta } from '../cards/Card';
import type { Settings } from '../../types';
import type { SetDefinition } from '../../engine';
import { openPack, prefetchNextPack, type OpenedPack } from '../../game/pulls';
import { triggerRarityConfetti, triggerHoloSparkles } from '../../utils/confettiEffects';
import { usePackCutter } from '../../hooks/usePackCutter';
import { useAudio } from '../../hooks/useAudio';
import { useKeyboardControls } from '../../hooks/useKeyboardControls';
import { BRAINROT_VOICES, EFFECT_SOUNDS, CARD_FLIP_SRC } from '../../constants/audio';
import { effectsLevel } from '../../utils/settings';
import PackCuttingUI from './PackCuttingUI';
import CardRevealUI from './CardRevealUI';
import PackSummaryUI from './PackSummaryUI';
import { packImageUrl } from '../../content/art';
import { isBigPull, isSpecialReveal, markNew, nextSpecialRevealIndex, revealOrder, SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';
import '../../styles/PackOpener.css';

const Motion = motion;

interface PreloadedAssets {
  brainrotVoices: HTMLAudioElement[];
  cardFlip: HTMLAudioElement;
  effects: HTMLAudioElement[];
}

interface PackOpenerProps {
  /** Called once every card has been revealed. */
  onOpen: (pack: OpenedPack) => void;
  onShare: (pack: OpenedPack) => void;
  /** True while a pack is being opened (its ticket is spent but it isn't recorded yet). */
  onBusyChange?: (busy: boolean) => void;
  set: SetDefinition;
  disabled?: boolean;
  settings: Settings;
  /** The chosen, unlocked back, shared by the active card and the remaining stack. */
  cardBack?: string;
  /** Whether the collection already had this card before the pack (for the NEW sticker). */
  isOwned?: (cardKey: string) => boolean;
}

const PackOpener = ({ onOpen, onShare, onBusyChange, set, disabled = false, settings, cardBack, isOwned }: PackOpenerProps) => {
  const [isOpening, setIsOpening] = useState(false);
  const [openedPack, setOpenedPack] = useState<OpenedPack | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openedCards, setOpenedCards] = useState<CardWithMeta[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPackCut, setIsPackCut] = useState(false);
  const [preloadedAssets, setPreloadedAssets] = useState<PreloadedAssets | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [revealLocked, setRevealLocked] = useState(false);
  const [celebratingCardId, setCelebratingCardId] = useState<CardWithMeta['uniqueId'] | null>(null);
  const [skipping, setSkipping] = useState(false);
  const packDesign = packImageUrl(set.id);
  const [hasMovedMouse, setHasMovedMouse] = useState(false);
  const effectsVolume = effectsLevel(settings.effectsVolume);
  const pauseBigPulls = settings.pauseBigPulls !== false;

  const { playAndCleanup, preloadAudio, cleanupAudio, playRandom } = useAudio();

  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleInteractionRef = useRef<() => void>(() => {});
  // Set synchronously before React renders: rapid taps and held keys share the same guard.
  const revealLockedUntilRef = useRef(0);
  const celebrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skippingRef = useRef(false);
  /** Whether this pack has been handed to onOpen; a pack is recorded once, however it's finished. */
  const recordedRef = useRef(false);

  const startOpening = useCallback(async () => {
    let pack: OpenedPack;
    try {
      // Usually instant: the ticket was mined while the pack was on screen.
      pack = await openPack(set);
    } catch (error) {
      console.error('Could not open pack', error);
      setOpenError('This pack refused to open. Try again!');
      setIsPackCut(false);
      return;
    }
    const brainrotVoices = preloadAudio(BRAINROT_VOICES);
    const cardFlip = preloadAudio([CARD_FLIP_SRC])[0];
    const effects = preloadAudio(EFFECT_SOUNDS);

    setPreloadedAssets({ brainrotVoices, cardFlip, effects });
    recordedRef.current = false;
    setOpenedPack(pack);
    // Shown rarest last, with NEW on cards the collection didn't have yet. The pack itself (and its
    // proof and history) keeps the engine's order.
    setOpenedCards(markNew(revealOrder(pack.cards), (key) => isOwned?.(key) ?? true));
    setCurrentIndex(0);
    setIsOpening(true);
  }, [set, preloadAudio, isOwned]);

  // Mine the next pack's ticket while this one is on screen.
  useEffect(() => {
    if (!isOpening) prefetchNextPack(set);
  }, [isOpening, set]);

  // From the tear on, the ticket is spent: the app mustn't swap sets (or open a sheet over it) until
  // the pack is recorded. The ticket can still be mining here on a slow phone.
  // The summary comes after it's recorded, so the tabs and the pack switcher come back there.
  useEffect(() => onBusyChange?.((isOpening && !showSummary) || (isPackCut && !isOpening)), [isOpening, isPackCut, showSummary, onBusyChange]);

  // Mining taking a while: say so, rather than leave a torn pack sitting still.
  const [slowOpen, setSlowOpen] = useState(false);
  /** A press on the pack just missed the tear line, so it shows where to swipe for a moment. */
  const [nudging, setNudging] = useState(false);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudge = useCallback(() => {
    setNudging(true);
    if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = setTimeout(() => setNudging(false), 1800);
  }, []);
  useEffect(() => {
    if (!isPackCut || isOpening) return;
    const timer = window.setTimeout(() => setSlowOpen(true), 1200);
    return () => {
      window.clearTimeout(timer);
      setSlowOpen(false);
    };
  }, [isPackCut, isOpening]);

  const handleCutComplete = useCallback(() => {
    setIsPackCut(true);
    if (openTimeoutRef.current) {
      window.clearTimeout(openTimeoutRef.current);
    }
    setOpenError(null);
    openTimeoutRef.current = window.setTimeout(() => {
      void startOpening();
    }, 460);
  }, [startOpening]);

  const {
    packRef,
    isCutting,
    cutPoints,
    sparks,
    resetCutState,
    completeCut,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    endCutAttempt,
    cleanup: cleanupCutter,
  } = usePackCutter({
    onCutComplete: handleCutComplete,
    isOpening,
    isPackCut,
    volume: effectsVolume,
    particlesEnabled: settings.particlesEnabled,
    disabled,
    onMiss: nudge,
  });

  // A pack that refused to open can be torn again, as its error asks.
  useEffect(() => {
    if (openError) resetCutState();
  }, [openError, resetCutState]);

  const finishPack = useCallback(() => {
    skippingRef.current = false;
    setSkipping(false);
    if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    celebrationTimerRef.current = null;
    revealLockedUntilRef.current = 0;
    setRevealLocked(false);
    setCelebratingCardId(null);
    if (preloadedAssets) {
      cleanupAudio(preloadedAssets.brainrotVoices);
      cleanupAudio([preloadedAssets.cardFlip]);
      cleanupAudio(preloadedAssets.effects);
    }
    setPreloadedAssets(null);
    setIsOpening(false);
    setOpenedPack(null);
    setOpenedCards([]);
    setCurrentIndex(0);
    setIsPackCut(false);
    setShowSummary(false);
    setHasMovedMouse(false);
    resetCutState();
  }, [resetCutState, preloadedAssets, cleanupAudio]);

  /** The pack as the engine dealt it, face up: what's recorded and shared (the reveal order is only for show). */
  const dealtPack = useCallback((): OpenedPack | null => (openedPack ? { ...openedPack, cards: openedPack.cards.map((card) => ({ ...card, isRevealed: true })) } : null), [openedPack]);

  const recordPack = useCallback(() => {
    const pack = dealtPack();
    if (!pack || recordedRef.current) return;
    recordedRef.current = true;
    onOpen(pack);
  }, [dealtPack, onOpen]);

  const nextCard = useCallback(() => {
    if (pauseBigPulls && performance.now() < revealLockedUntilRef.current) return;
    if (currentIndex < openedCards.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      recordPack();
      setShowSummary(true);
    }
  }, [currentIndex, openedCards, recordPack, pauseBigPulls]);

  /** With the pause enabled, Skip still gives each valuable card its full reveal. */
  const skipAll = useCallback(() => {
    if (disabled || skippingRef.current || (pauseBigPulls && performance.now() < revealLockedUntilRef.current)) return;
    if (!pauseBigPulls) {
      setOpenedCards(openedCards.map((card) => ({ ...card, isRevealed: true })));
      recordPack();
      setShowSummary(true);
      return;
    }
    skippingRef.current = true;
    setSkipping(true);
  }, [disabled, pauseBigPulls, openedCards, recordPack]);

  const leaveReveal = useCallback(() => {
    if (pauseBigPulls && performance.now() < revealLockedUntilRef.current) return;
    recordPack();
    finishPack();
  }, [pauseBigPulls, recordPack, finishPack]);

  // A press on the empty space around the card leaves the reveal. A fling that starts on the card and
  // is released off it clicks their shared ancestor, so the press must start and end on empty space.
  // A click with no pointer press (keyboard or assistive tech) can't be a drag.
  const blankPressRef = useRef<boolean | null>(null);
  const onBlank = (event: SyntheticEvent) => event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('active-card-container');

  const closeSummary = useCallback(() => {
    finishPack();
  }, [finishPack]);

  const handleFlip = useCallback(() => {
    const currentCard = openedCards[currentIndex];
    if (!currentCard || currentCard.isRevealed || !preloadedAssets) return;

    if (isSpecialReveal(currentCard)) {
      // The celebration always plays; the setting controls only the input lock.
      setCelebratingCardId(currentCard.uniqueId);
      revealLockedUntilRef.current = pauseBigPulls ? performance.now() + SPECIAL_REVEAL_DURATION_MS : 0;
      setRevealLocked(pauseBigPulls);
      if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
      celebrationTimerRef.current = setTimeout(() => {
        revealLockedUntilRef.current = 0;
        celebrationTimerRef.current = null;
        setRevealLocked(false);
        setCelebratingCardId(null);
      }, SPECIAL_REVEAL_DURATION_MS);
    }

    if (effectsVolume > 0) {
      playAndCleanup(preloadedAssets.cardFlip, effectsVolume);
      playRandom(preloadedAssets.effects, effectsVolume);
    }

    setOpenedCards(openedCards.map((card, index) => index === currentIndex ? { ...card, isRevealed: true } : card));

    // A short buzz on phones: a tick for any card, a double for big pulls.
    if (typeof navigator.vibrate === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      navigator.vibrate(isBigPull(currentCard) ? [18, 60, 30] : 8);
    }

    if (settings.particlesEnabled) {
      // A finish or misprint gets at least an Epic's confetti.
      const modified = !!currentCard.finish || !!currentCard.misprint;
      const plainish = currentCard.rarity === 'COMMON' || currentCard.rarity === 'UNCOMMON' || currentCard.rarity === 'RARE';
      triggerRarityConfetti(modified && plainish ? 'EPIC' : currentCard.rarity);
      if (currentCard.isHolo) {
        triggerHoloSparkles();
      }
    }
  }, [openedCards, currentIndex, preloadedAssets, playAndCleanup, playRandom, settings, effectsVolume, pauseBigPulls]);

  // A skip is a short sequence: mount each valuable card face down, flip it, wait for its lock,
  // then move to the next. Already revealed cards don't repeat their celebration.
  useEffect(() => {
    if (!skipping || (revealLocked && pauseBigPulls) || !isOpening || showSummary || disabled) return;
    // Give a newly mounted card a frame face down before starting its flip.
    const frame = requestAnimationFrame(() => {
      const nextIndex = pauseBigPulls ? nextSpecialRevealIndex(openedCards) : -1;
      if (nextIndex === -1) {
        setOpenedCards(openedCards.map((card) => ({ ...card, isRevealed: true })));
        recordPack();
        setShowSummary(true);
        skippingRef.current = false;
        setSkipping(false);
      } else if (currentIndex !== nextIndex) {
        setOpenedCards(openedCards.map((card, index) => index < nextIndex ? { ...card, isRevealed: true } : card));
        setCurrentIndex(nextIndex);
      } else {
        handleFlip();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [skipping, revealLocked, pauseBigPulls, isOpening, showSummary, disabled, openedCards, currentIndex, handleFlip, recordPack]);

  const handleInteraction = useCallback(() => {
    if (!isOpening || showSummary || disabled || skippingRef.current || (pauseBigPulls && performance.now() < revealLockedUntilRef.current)) return;

    const currentItem = openedCards[currentIndex];
    if (currentItem && !currentItem.isRevealed) {
      handleFlip();
    } else {
      nextCard();
    }
  }, [isOpening, showSummary, disabled, openedCards, currentIndex, handleFlip, nextCard, pauseBigPulls]);

  // Held Space reads the current interaction without a stale closure.
  useEffect(() => {
    handleInteractionRef.current = handleInteraction;
  }, [handleInteraction]);

  // Use keyboard controls hook
  useKeyboardControls({
    isOpening,
    showSummary,
    disabled,
    onCloseSummary: closeSummary,
    onOpenPack: () => !isPackCut && completeCut(),
    handleInteractionRef,
  });

  // Play "what kind of brainrot" when a new card appears
  useEffect(() => {
    if (isOpening && preloadedAssets && openedCards[currentIndex] && !openedCards[currentIndex].isRevealed && effectsVolume > 0) {
      const timer = setTimeout(() => {
        playRandom(preloadedAssets.brainrotVoices, effectsVolume);
      }, 700);
      return () => clearTimeout(timer);
    }
  }, [isOpening, currentIndex, preloadedAssets, openedCards, playRandom, effectsVolume]);

  // Hide mouse hint after user moves mouse
  useEffect(() => {
    if (!isOpening || hasMovedMouse) return;
    const handleMouseMove = () => setHasMovedMouse(true);
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [isOpening, hasMovedMouse]);

  // Pointer event listeners for cutting
  useEffect(() => {
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    window.addEventListener('blur', endCutAttempt);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
      window.removeEventListener('blur', endCutAttempt);
    };
  }, [handlePointerDown, handlePointerMove, handlePointerEnd, endCutAttempt]);

  // Unmounted mid-reveal (the set list changed under it): the pack still goes to the collection.
  const recordOnUnmountRef = useRef(recordPack);
  useEffect(() => {
    recordOnUnmountRef.current = recordPack;
  }, [recordPack]);

  useEffect(() => () => recordOnUnmountRef.current(), []);

  // Cleanup on unmount
  useEffect(() => () => {
    if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    if (openTimeoutRef.current) {
      window.clearTimeout(openTimeoutRef.current);
    }
    cleanupCutter();
  }, [cleanupCutter]);

  const currentCard = openedCards[currentIndex];

  return (
    <div className="pack-opener-container">
      <AnimatePresence mode="wait">
        {!isOpening ? (
          <Motion.div
            key="pack"
            initial={{ y: '-100vh', opacity: 0, rotate: -10 }}
            animate={{ y: 0, opacity: 1, rotate: 0 }}
            // Quick, on its own timing: the drop-in spring's long tail left the screen blank before the reveal.
            exit={{ scale: 1.25, opacity: 0, transition: { duration: 0.25, ease: 'easeIn' } }}
            transition={{
              type: 'spring',
              stiffness: 80,
              damping: 12,
              mass: 1
            }}
            className="pack-display"
          >
            <PackCuttingUI
              packRef={packRef}
              packDesign={packDesign}
              set={set}
              error={openError}
              isCutting={isCutting}
              isPackCut={isPackCut}
              waiting={slowOpen && isPackCut && !isOpening}
              nudging={nudging}
              cutPoints={cutPoints}
              sparks={sparks}
            />
          </Motion.div>
        ) : (
          <Motion.div
            key="opening"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            className={`card-reveal-area ${!showSummary && !(revealLocked && pauseBigPulls) ? 'can-leave' : ''}`}
            onPointerDownCapture={(event) => { blankPressRef.current = onBlank(event); }}
            onPointerUpCapture={(event) => { blankPressRef.current = blankPressRef.current === true && onBlank(event); }}
            onClick={(event) => {
              const pressedBlank = blankPressRef.current;
              blankPressRef.current = null;
              if (!showSummary && pressedBlank !== false && onBlank(event)) leaveReveal();
            }}
          >
            {!showSummary ? (
              <CardRevealUI
                currentCard={currentCard}
                cardBack={cardBack}
                currentIndex={currentIndex}
                totalCards={openedCards.length}
                hasMovedMouse={hasMovedMouse}
                onInteraction={handleInteraction}
                onSkip={skipAll}
                onLeave={leaveReveal}
                revealLocked={revealLocked && pauseBigPulls}
                celebrating={celebratingCardId === currentCard?.uniqueId}
                skipping={skipping}
              />
            ) : (
              <PackSummaryUI
                openedCards={openedCards}
                set={set}
                onClose={closeSummary}
                onShare={openedPack ? () => onShare(dealtPack()!) : undefined}
              />
            )}
          </Motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default PackOpener;
