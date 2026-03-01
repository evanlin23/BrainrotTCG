import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import Card from './Card';
import '../styles/PackOpener.css';

const PackOpener = ({ onOpen, cards }) => {
    const [isOpening, setIsOpening] = useState(false);
    const [openedCards, setOpenedCards] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);

    const startOpening = useCallback(() => {
        setIsOpening(true);
        // Generate 5 random cards for the pack
        const pack = Array.from({ length: 5 }, () => {
            const random = Math.random() * 100;
            // Basic rarity distribution
            let filtered;
            if (random < 2) filtered = cards.filter(c => c.rarity === 'LEGENDARY');
            else if (random < 10) filtered = cards.filter(c => c.rarity === 'EPIC');
            else if (random < 30) filtered = cards.filter(c => c.rarity === 'RARE');
            else filtered = cards.filter(c => c.rarity === 'RARE');

            if (!filtered.length) filtered = cards; // Fallback
            return { ...filtered[Math.floor(Math.random() * filtered.length)], uniqueId: Math.random(), isRevealed: false };
        });
        setOpenedCards(pack);
        setCurrentIndex(0);
    }, [cards]);

    const nextCard = useCallback(() => {
        if (currentIndex < openedCards.length - 1) {
            setCurrentIndex(currentIndex + 1);
        } else {
            onOpen(openedCards);
            setIsOpening(false);
            setOpenedCards([]);
        }
    }, [currentIndex, openedCards, onOpen]);

    const handleFlip = useCallback(() => {
        const currentCard = openedCards[currentIndex];
        if (!currentCard) return;

        const audio = new Audio('/sounds/ding.mp3');
        audio.play().catch(e => console.log("Audio playback failed:", e));

        const newCards = [...openedCards];
        newCards[currentIndex].isRevealed = true;
        setOpenedCards(newCards);

        if (currentCard.rarity === 'LEGENDARY' || currentCard.rarity === 'EPIC') {
            confetti({
                particleCount: 150,
                spread: 70,
                origin: { y: 0.6 },
                colors: currentCard.rarity === 'LEGENDARY' ? ['#ff8000', '#ffd700'] : ['#a335ee', '#bc13fe']
            });
        }
    }, [openedCards, currentIndex]);

    const handleInteraction = useCallback(() => {
        if (!isOpening) {
            startOpening();
        } else {
            const currentItem = openedCards[currentIndex];
            if (currentItem && !currentItem.isRevealed) {
                handleFlip();
            } else {
                nextCard();
            }
        }
    }, [isOpening, openedCards, currentIndex, startOpening, handleFlip, nextCard]);

    React.useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.code === 'Space') {
                e.preventDefault(); // Prevent page scroll
                handleInteraction();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleInteraction]);

    const currentCard = openedCards[currentIndex];

    return (
        <div className="pack-opener-container">
            <AnimatePresence mode="wait">
                {!isOpening ? (
                    <motion.div
                        key="pack"
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 1.5, opacity: 0 }}
                        className="pack-display"
                    >
                        <div className="pack-graphic">
                            <div className="pack-title">BRAINROT</div>
                        </div>
                        <button className="premium-btn" onClick={handleInteraction}>
                            Open Pack
                        </button>
                    </motion.div>
                ) : (
                    <motion.div
                        key="opening"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="card-reveal-area"
                    >
                        <div className="reveal-counter">
                            {currentIndex + 1} / {openedCards.length}
                        </div>

                        <AnimatePresence mode="wait">
                            {currentCard && (
                                <motion.div
                                    key={currentCard.uniqueId}
                                    initial={{ x: 500, opacity: 0, rotate: 10 }}
                                    animate={{ x: 0, opacity: 1, rotate: 0 }}
                                    exit={{ x: -500, opacity: 0, rotate: -10 }}
                                    className="active-card-container"
                                >
                                    <Card
                                        card={currentCard}
                                        isFlipped={currentCard.isRevealed}
                                        onFlip={handleInteraction}
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <div className="tip-text">
                            {currentCard?.isRevealed ? "Click or Space to see next" : "Click or Space to reveal!"}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default PackOpener;
