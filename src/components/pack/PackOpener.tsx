import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Card as CardType } from '../../data/cards';
import type { CardWithMeta } from '../cards/Card';
import { generatePack } from '../../utils/packGenerator';
import { triggerRarityConfetti, triggerHoloSparkles } from '../../utils/confettiEffects';
import { usePackCutter } from '../../hooks/usePackCutter';
import { useAudio } from '../../hooks/useAudio';
import { useKeyboardControls } from '../../hooks/useKeyboardControls';
import { BRAINROT_VOICES, EFFECT_SOUNDS, CARD_FLIP_SRC } from '../../constants/audio';
import PackCuttingUI from './PackCuttingUI';
import CardRevealUI from './CardRevealUI';
import PackSummaryUI from './PackSummaryUI';
import pack1 from '../../assets/packs/pack1.png';
import pack2 from '../../assets/packs/pack2.png';
import '../../styles/PackOpener.css';

const PACK_DESIGNS = [pack1, pack2];
const Motion = motion;

interface PreloadedAssets {
  brainrotVoices: HTMLAudioElement[];
  cardFlip: HTMLAudioElement;
  effects: HTMLAudioElement[];
}

interface PackOpenerProps {
  onOpen: (cards: CardWithMeta[]) => void;
  cards: CardType[];
  disabled?: boolean;
}

const PackOpener = ({ onOpen, cards, disabled = false }: PackOpenerProps) => {
  const [isOpening, setIsOpening] = useState(false);
  const [openedCards, setOpenedCards] = useState<CardWithMeta[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPackCut, setIsPackCut] = useState(false);
  const [preloadedAssets, setPreloadedAssets] = useState<PreloadedAssets | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [packDesign, setPackDesign] = useState(() => PACK_DESIGNS[Math.floor(Math.random() * PACK_DESIGNS.length)]);
  const [hasMovedMouse, setHasMovedMouse] = useState(false);
  const [autoMode, setAutoMode] = useState(false);

  const { playAndCleanup, preloadAudio, cleanupAudio, playRandom } = useAudio();

  const autoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleInteractionRef = useRef<() => void>(() => {});

  const startOpening = useCallback(() => {
    const pack = generatePack(cards);
    const brainrotVoices = preloadAudio(BRAINROT_VOICES);
    const cardFlip = preloadAudio([CARD_FLIP_SRC])[0];
    const effects = preloadAudio(EFFECT_SOUNDS);

    setPreloadedAssets({ brainrotVoices, cardFlip, effects });
    setOpenedCards(pack);
    setCurrentIndex(0);
    setIsOpening(true);
  }, [cards, preloadAudio]);

  const handleCutComplete = useCallback(() => {
    setIsPackCut(true);
    if (openTimeoutRef.current) {
      window.clearTimeout(openTimeoutRef.current);
    }
    openTimeoutRef.current = window.setTimeout(() => {
      startOpening();
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
  });

  const finishPack = useCallback(() => {
    if (preloadedAssets) {
      cleanupAudio(preloadedAssets.brainrotVoices);
      cleanupAudio([preloadedAssets.cardFlip]);
      cleanupAudio(preloadedAssets.effects);
    }
    setPreloadedAssets(null);
    setIsOpening(false);
    setOpenedCards([]);
    setCurrentIndex(0);
    setIsPackCut(false);
    setShowSummary(false);
    setHasMovedMouse(false);
    setPackDesign(PACK_DESIGNS[Math.floor(Math.random() * PACK_DESIGNS.length)]);
    resetCutState();
  }, [resetCutState, preloadedAssets, cleanupAudio]);

  const nextCard = useCallback(() => {
    if (currentIndex < openedCards.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      onOpen(openedCards);
      setShowSummary(true);
    }
  }, [currentIndex, openedCards, onOpen]);

  const closeSummary = useCallback(() => {
    finishPack();
  }, [finishPack]);

  const handleFlip = useCallback(() => {
    const currentCard = openedCards[currentIndex];
    if (!currentCard || !preloadedAssets) return;

    playAndCleanup(preloadedAssets.cardFlip);
    playRandom(preloadedAssets.effects);

    const newCards = [...openedCards];
    newCards[currentIndex].isRevealed = true;
    setOpenedCards(newCards);

    triggerRarityConfetti(currentCard.rarity);
    if (currentCard.isHolo) {
      triggerHoloSparkles();
    }
  }, [openedCards, currentIndex, preloadedAssets, playAndCleanup, playRandom]);

  const handleInteraction = useCallback(() => {
    if (!isOpening) return;

    const currentItem = openedCards[currentIndex];
    if (currentItem && !currentItem.isRevealed) {
      handleFlip();
    } else {
      nextCard();
    }
  }, [isOpening, openedCards, currentIndex, handleFlip, nextCard]);

  // Keep ref updated for use in intervals (avoids stale closure)
  handleInteractionRef.current = handleInteraction;

  // Use keyboard controls hook
  useKeyboardControls({
    isOpening,
    showSummary,
    disabled,
    onCloseSummary: closeSummary,
    onToggleAutoMode: () => setAutoMode(prev => !prev),
    handleInteractionRef,
  });

  // Play "what kind of brainrot" when a new card appears
  useEffect(() => {
    if (isOpening && preloadedAssets && openedCards[currentIndex] && !openedCards[currentIndex].isRevealed) {
      const timer = setTimeout(() => {
        playRandom(preloadedAssets.brainrotVoices);
      }, 700);
      return () => clearTimeout(timer);
    }
  }, [isOpening, currentIndex, preloadedAssets, openedCards, playRandom]);

  // Hide mouse hint after user moves mouse
  useEffect(() => {
    if (!isOpening || hasMovedMouse) return;
    const handleMouseMove = () => setHasMovedMouse(true);
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [isOpening, hasMovedMouse]);

  // Auto mode effect
  useEffect(() => {
    if (autoMode && !disabled) {
      autoIntervalRef.current = setInterval(() => {
        if (showSummary) {
          closeSummary();
        } else if (!isOpening && !isPackCut) {
          completeCut();
        } else if (isOpening) {
          handleInteraction();
        }
      }, 100);
    } else {
      if (autoIntervalRef.current) {
        clearInterval(autoIntervalRef.current);
        autoIntervalRef.current = null;
      }
    }

    return () => {
      if (autoIntervalRef.current) {
        clearInterval(autoIntervalRef.current);
        autoIntervalRef.current = null;
      }
    };
  }, [autoMode, disabled, showSummary, isOpening, isPackCut, closeSummary, completeCut, handleInteraction]);

  // Stop auto mode when disabled
  useEffect(() => {
    if (disabled && autoMode) {
      setAutoMode(false);
    }
  }, [disabled, autoMode]);

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

  // Cleanup on unmount
  useEffect(() => () => {
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
            exit={{ scale: 1.5, opacity: 0 }}
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
              isCutting={isCutting}
              isPackCut={isPackCut}
              cutPoints={cutPoints}
              sparks={sparks}
            />
          </Motion.div>
        ) : (
          <Motion.div
            key="opening"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="card-reveal-area"
          >
            {!showSummary ? (
              <CardRevealUI
                currentCard={currentCard}
                currentIndex={currentIndex}
                totalCards={openedCards.length}
                hasMovedMouse={hasMovedMouse}
                onInteraction={handleInteraction}
              />
            ) : (
              <PackSummaryUI
                openedCards={openedCards}
                onClose={closeSummary}
              />
            )}
          </Motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default PackOpener;
