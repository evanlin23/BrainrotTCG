import { motion, AnimatePresence } from 'framer-motion';
import Card from '../cards/Card';
import type { CardWithMeta } from '../cards/Card';

const Motion = motion;

interface CardRevealUIProps {
  currentCard: CardWithMeta;
  currentIndex: number;
  totalCards: number;
  hasMovedMouse: boolean;
  onInteraction: () => void;
}

const CardRevealUI = ({
  currentCard,
  currentIndex,
  totalCards,
  hasMovedMouse,
  onInteraction,
}: CardRevealUIProps) => {
  return (
    <>
      <div className="reveal-counter">
        {currentIndex + 1} / {totalCards}
      </div>

      <AnimatePresence mode="wait">
        {currentCard && (
          <Motion.div
            key={currentCard.uniqueId}
            initial={{ x: 500, opacity: 0, rotate: 10 }}
            animate={{ x: 0, opacity: 1, rotate: 0 }}
            exit={{ x: -500, opacity: 0, rotate: -10 }}
            className="active-card-container"
          >
            <Card
              card={currentCard}
              isFlipped={currentCard.isRevealed}
              onFlip={onInteraction}
            />
          </Motion.div>
        )}
      </AnimatePresence>

      <div className="tip-text">
        {currentCard?.isRevealed ? "Click or Space to see next" : "Click or Space to reveal"}
      </div>
      <div className={`mouse-hint ${hasMovedMouse ? 'fade-out' : ''}`}>Move mouse around card to tilt</div>
    </>
  );
};

export default CardRevealUI;
