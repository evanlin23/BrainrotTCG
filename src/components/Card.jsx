import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import '../styles/Card.css';

const Card = ({ card, isFlipped, onFlip, slowFlip = false }) => {
    const [isHovered, setIsHovered] = useState(false);

    return (
        <div
            className={`card-wrapper ${card.rarity.toLowerCase()}`}
            onContextMenu={(e) => e.preventDefault()}
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
                    <div className="back-design">
                        <div className="logo-placeholder">ROT</div>
                    </div>
                </div>

                {/* Card Front */}
                <div className="card-face card-front">
                    <div className="card-header">
                        <span className="card-name">{card.name}</span>
                        <span className="card-hp">HP {card.hp}</span>
                    </div>

                    <div className="card-image-container">
                        <img src={card.image} alt={card.name} className="card-image" />
                        <div className="holo-overlay"></div>
                    </div>

                    <div className="card-info">
                        <div className="card-description">{card.description}</div>
                        <div className="card-stats">
                            <div className="stat-item">
                                <span className="stat-label">ATK</span>
                                <span className="stat-value">{card.atk}</span>
                            </div>
                            <div className="rarity-badge">{card.rarity}</div>
                        </div>
                    </div>
                </div>
            </motion.div>
        </div>
    );
};

export default Card;
