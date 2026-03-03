import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import '../../styles/Card.css';
import cardBackImage from '../../assets/images/card_back.png';
import type { Card as CardType } from '../../data/cards';

export interface CardWithMeta extends CardType {
    uniqueId: number;
    isRevealed: boolean;
    isHolo: boolean;
}

interface CardProps {
    card: CardWithMeta;
    isFlipped: boolean;
    onFlip: () => void;
    slowFlip?: boolean;
}

const Card = ({ card, isFlipped, onFlip, slowFlip = false }: CardProps) => {
    const cardRef = useRef<HTMLDivElement>(null);
    const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0 });
    const [hasShined, setHasShined] = useState(false);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!cardRef.current) return;

            const rect = cardRef.current.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            const percentX = (e.clientX - centerX) / (rect.width / 2);
            const percentY = (e.clientY - centerY) / (rect.height / 2);

            const clampedX = Math.max(-2, Math.min(2, percentX));
            const clampedY = Math.max(-2, Math.min(2, percentY));

            const maxTilt = 12;
            setTilt({
                rotateX: -clampedY * maxTilt,
                rotateY: clampedX * maxTilt
            });
        };

        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, []);

    // Trigger shine animation when card is flipped and is holo
    useEffect(() => {
        if (isFlipped && card.isHolo && !hasShined) {
            setHasShined(true);
        }
    }, [isFlipped, card.isHolo, hasShined]);

    const cardClasses = [
        'card-wrapper',
        isFlipped ? card.rarity.toLowerCase() : '',
        card.isHolo ? 'holo' : '',
        hasShined ? 'shine-played' : ''
    ].filter(Boolean).join(' ');

    return (
        <div
            ref={cardRef}
            className={cardClasses}
            onContextMenu={(e) => e.preventDefault()}
            style={{
                transform: `perspective(1000px) rotateX(${tilt.rotateX}deg) rotateY(${tilt.rotateY}deg)`,
                transition: 'transform 0.15s ease-out'
            }}
        >
            <motion.div
                className="card-inner"
                initial={false}
                animate={{ rotateY: isFlipped ? 180 : 0 }}
                transition={{
                    type: 'spring',
                    stiffness: slowFlip ? 30 : 260,
                    damping: slowFlip ? 15 : 20
                }}
                onClick={onFlip}
            >
                {/* Card Back */}
                <div className="card-face card-back">
                    <img src={cardBackImage} alt="Card back" className="card-back-image" draggable="false" />
                </div>

                {/* Card Front */}
                <div className="card-face card-front">
                    <img src={card.image} alt={card.name} className="card-full-image" draggable="false" />
                    {card.isHolo && <div className="holo-shine-overlay"></div>}
                    <div className="holo-overlay"></div>
                </div>
            </motion.div>
        </div>
    );
};

export default Card;
