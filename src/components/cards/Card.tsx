import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import '../../styles/Card.css';
import cardBackImage from '../../assets/images/card_back.webp';
import type { CardWithMeta } from '../../types/card';
import { FINISH_INFO, modifierClasses, modifierLabel } from '../../game/modifiers';
import CardImage from './CardImage';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { cardFaceLabel } from './cardLabel';

export type { CardWithMeta };

interface CardProps {
    card: CardWithMeta;
    isFlipped: boolean;
    /** A click on the card. The reveal leaves it out: its card is a button that handles the click itself. */
    onFlip?: () => void;
    slowFlip?: boolean;
    /** Before the flip, light the back's edge in the card's rarity colour (rare and up). */
    tell?: boolean;
}

const Card = ({ card, isFlipped, onFlip, slowFlip = false, tell = false }: CardProps) => {
    const cardRef = useRef<HTMLDivElement>(null);
    const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0 });
    const [hasShined, setHasShined] = useState(false);
    const reducedMotion = usePrefersReducedMotion();

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
        // the card stuck at an angle. No tilt under reduced motion either, and turning it on mid-pack
        // stops the tilt straight away.
        if (reducedMotion || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, [reducedMotion]);
    // Turning reduced motion on mid-pack levels the card and forgets the angle, so turning it back
    // off doesn't snap the card to where the mouse last was.
    if (reducedMotion && (tilt.rotateX !== 0 || tilt.rotateY !== 0)) {
        setTilt({ rotateX: 0, rotateY: 0 });
    }

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
                {/* Card Back. Only the face that shows is read out, so the front can't spoil the flip. The
                    flip button already says which card this is, so the back image is decoration. */}
                <div className="card-face card-back" aria-hidden={isFlipped}>
                    <img src={cardBackImage} alt="" className="card-back-image" draggable="false" />
                </div>

                {/* Card Front */}
                <div className={`card-face card-front ${modifierClasses(card)}`} aria-hidden={!isFlipped}>
                    <CardImage src={card.image} finish={card.finish} alt={cardFaceLabel(card)} className="card-full-image" draggable="false" />
                    {card.misprint && <CardImage src={card.image} finish={card.finish} alt="" aria-hidden="true" className="misprint-ghost" draggable="false" />}
                    {card.isHolo && <div className="holo-shine-overlay"></div>}
                    <div className="holo-overlay"></div>
                    {/* The reveal's announcement already says New and the finish, so the stickers stay silent. */}
                    {card.isNew && <span className="new-sticker" aria-hidden="true">New</span>}
                    {modifierLabel(card, false) && <span className="modifier-sticker" aria-hidden="true">{modifierLabel(card, false)}</span>}
                </div>
            </motion.div>
        </div>
    );
};

export default Card;
