import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import '../../styles/Card.css';
import cardBackImage from '../../assets/images/card_back.webp';
import { CARD_RARITIES, type Card as CardType } from '../../data/cards';
import type { Finish } from '../../engine';
import { FINISH_INFO, modifierClasses, modifierLabel } from '../../game/modifiers';
import CardImage from './CardImage';
import { prefersReducedMotion } from '../../utils/motion';

export interface CardWithMeta extends CardType {
    uniqueId: number;
    isRevealed: boolean;
    isHolo: boolean;
    /** Sets with modifiers: the card's finish and whether it's a misprint (game/modifiers.ts). */
    finish?: Finish | null;
    misprint?: boolean;
    /** The player didn't own this card before the pack it came in. */
    isNew?: boolean;
}

interface CardProps {
    card: CardWithMeta;
    isFlipped: boolean;
    onFlip: () => void;
    slowFlip?: boolean;
    /** Before the flip, light the back's edge in the card's rarity colour (rare and up). */
    tell?: boolean;
}

/**
 * The face's accessible name: the card's name, rarity and holo, which the art shows only by colour and
 * shine. A finish or misprint is left out because the face's sticker already says it.
 */
const cardFaceLabel = (card: Pick<CardWithMeta, 'name' | 'rarity' | 'isHolo'>): string =>
    `${card.name}, ${card.isHolo ? 'Holo ' : ''}${CARD_RARITIES[card.rarity].name}`;

const Card = ({ card, isFlipped, onFlip, slowFlip = false, tell = false }: CardProps) => {
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

        // Tilt follows a real mouse only: phones send a mousemove with every tap, which would leave
        // the card stuck at an angle. No tilt under reduced motion either.
        if (prefersReducedMotion() || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, []);

    // Trigger shine animation once, the first time a holo card is flipped
    if (isFlipped && card.isHolo && !hasShined) {
        setHasShined(true);
    }

    const cardClasses = [
        'card-wrapper',
        isFlipped ? card.rarity.toLowerCase() : '',
        !isFlipped && tell ? `tell tell-${card.rarity.toLowerCase()}` : '',
        !isFlipped && tell && card.isHolo ? 'tell-holo' : '',
        !isFlipped && tell && card.finish ? 'tell-finish' : '',
        !isFlipped && tell && !card.finish && card.misprint ? 'tell-misprint' : '',
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
                ...(card.finish ? { '--finish-tell': FINISH_INFO[card.finish].color } : {}),
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
                {/* Card Back. Only the face that shows is read out, so the front can't spoil the flip. */}
                <div className="card-face card-back" aria-hidden={isFlipped}>
                    <img src={cardBackImage} alt="Card back" className="card-back-image" draggable="false" />
                </div>

                {/* Card Front */}
                <div className={`card-face card-front ${modifierClasses(card)}`} aria-hidden={!isFlipped}>
                    <CardImage src={card.image} finish={card.finish} alt={cardFaceLabel(card)} className="card-full-image" draggable="false" />
                    {card.misprint && <CardImage src={card.image} finish={card.finish} alt="" aria-hidden="true" className="misprint-ghost" draggable="false" />}
                    {card.isHolo && <div className="holo-shine-overlay"></div>}
                    <div className="holo-overlay"></div>
                    {card.isNew && <span className="new-sticker">New</span>}
                    {modifierLabel(card, false) && <span className="modifier-sticker">{modifierLabel(card, false)}</span>}
                </div>
            </motion.div>
        </div>
    );
};

export default Card;
