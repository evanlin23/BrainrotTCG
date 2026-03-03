import { useState, useRef, useEffect } from 'react';
import type { Card } from '../../data/cards';
import { getCardValue } from '../../data/cards';

interface CardViewerModalProps {
  card: Card;
  hasNormal: boolean;
  hasHolo: boolean;
  initialHolo: boolean;
  onClose: () => void;
}

const CardViewerModal = ({ card, hasNormal, hasHolo, initialHolo, onClose }: CardViewerModalProps) => {
  const [isHolo, setIsHolo] = useState(initialHolo);
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0 });

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

      const maxTilt = 15;
      setTilt({
        rotateX: -clampedY * maxTilt,
        rotateY: clampedX * maxTilt
      });
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!cardRef.current || e.touches.length === 0) return;

      const touch = e.touches[0];
      const rect = cardRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const percentX = (touch.clientX - centerX) / (rect.width / 2);
      const percentY = (touch.clientY - centerY) / (rect.height / 2);

      const clampedX = Math.max(-2, Math.min(2, percentX));
      const clampedY = Math.max(-2, Math.min(2, percentY));

      const maxTilt = 15;
      setTilt({
        rotateX: -clampedY * maxTilt,
        rotateY: clampedX * maxTilt
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchmove', handleTouchMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchmove', handleTouchMove);
    };
  }, []);

  const classes = [
    'card-viewer-card',
    card.rarity.toLowerCase(),
    isHolo ? 'holo' : ''
  ].filter(Boolean).join(' ');

  return (
    <div className="card-viewer-overlay" onClick={onClose}>
      <div className="card-viewer-content" onClick={(e) => e.stopPropagation()}>
        <div
          ref={cardRef}
          className={classes}
          style={{
            transform: `perspective(1000px) rotateX(${tilt.rotateX}deg) rotateY(${tilt.rotateY}deg)`,
            transition: 'transform 0.1s ease-out',
            transformStyle: 'preserve-3d'
          }}
        >
          <img src={card.image} alt={card.name} draggable="false" />
        </div>

        <div className="card-viewer-info" style={{ textAlign: 'center', marginTop: '1rem', color: 'white', textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>
          <p style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>
            Value: {getCardValue(card.rarity, isHolo)} Buhcoin{getCardValue(card.rarity, isHolo) !== 1 ? 's' : ''}
          </p>
          {hasNormal && hasHolo && (
            <button
              onClick={(e) => { e.stopPropagation(); setIsHolo(!isHolo); }}
              style={{
                marginTop: '0.5rem',
                padding: '0.5rem 1rem',
                background: isHolo ? 'linear-gradient(45deg, #ffd700, #ff8c00)' : 'rgba(255, 255, 255, 0.2)',
                border: 'none',
                borderRadius: '8px',
                color: isHolo ? '#000' : '#fff',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                boxShadow: isHolo ? '0 0 10px rgba(255, 215, 0, 0.5)' : 'none'
              }}
            >
              {isHolo ? 'Show Normal' : 'Show Shiny'}
            </button>
          )}
        </div>

        <button className="card-viewer-close" onClick={onClose}>&times;</button>
      </div>
    </div>
  );
};

export default CardViewerModal;
