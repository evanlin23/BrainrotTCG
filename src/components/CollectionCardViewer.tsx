import { useState, useRef, useEffect } from 'react';
import type { Card } from '../data/cards';

interface CollectionCardViewerProps {
  card: Card;
  hasHolo: boolean;
}

const CollectionCardViewer = ({ card, hasHolo }: CollectionCardViewerProps) => {
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

    // For touch devices, use touch events
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
    hasHolo ? 'holo' : ''
  ].filter(Boolean).join(' ');

  return (
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
  );
};

export default CollectionCardViewer;
