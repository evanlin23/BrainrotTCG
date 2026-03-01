import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import '../styles/Card.css';
import cardBackImage from '../assets/card_back.png';

const Card = ({ card, isFlipped, onFlip, slowFlip = false }) => {
    const cardRef = useRef(null);
    const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0 });

    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!cardRef.current) return;

            const rect = cardRef.current.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            // Calculate distance from center
            const percentX = (e.clientX - centerX) / (rect.width / 2);
            const percentY = (e.clientY - centerY) / (rect.height / 2);

            // Clamp values for smoother effect at distance
            const clampedX = Math.max(-2, Math.min(2, percentX));
            const clampedY = Math.max(-2, Math.min(2, percentY));

            // Apply rotation (max 15 degrees)
            const maxTilt = 12;
            setTilt({
                rotateX: -clampedY * maxTilt,
                rotateY: clampedX * maxTilt
            });
        };

        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, []);

    return (
        <div
            ref={cardRef}
            className={`card-wrapper ${card.rarity.toLowerCase()}`}
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
                    <div className="holo-overlay"></div>
                </div>
            </motion.div>
        </div>
    );
};

export default Card;
