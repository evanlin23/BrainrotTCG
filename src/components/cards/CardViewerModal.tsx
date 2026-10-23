import { useEffect, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import DeferredSheet from '../ui/DeferredSheet';
import { sheetLoader } from '../ui/sheetEntry';
import type { Card } from '../../data/cards';
import { cardPoints } from '../../data/cards';
import { FINISH_INFO, modifierClasses, modifierLabel, versionName } from '../../game/modifiers';
import { sameVersion, versionOf, type CardVersion, type OwnedVersion } from '../../game/versions';
import type { PullRef } from '../../game/pulls';
import Sheet from '../ui/Sheet';
import CardImage from './CardImage';
import CardVersionStats from './CardVersionStats';
import '../../styles/CardViewer.css';

interface CardViewerModalProps {
  /** The card. A pulled card carries its own version (holo, finish, misprint), and that's what shows. */
  card: Card & Partial<CardVersion>;
  /** In the collection: every version you own, most valuable first. It opens on the first. */
  versions?: OwnedVersion[];
  onClose: () => void;
  /** Only for cards the player owns (not someone else's shared pull). */
  canShare?: boolean;
  /** The pack this card came in (the pack summary): sharing it links to that pack. */
  pack?: PullRef;
}

const MAX_TILT = 12;
const loadCardShare = sheetLoader(() => import('../share/CardShareSheet'));

/** One card, big, tilting with the pointer. */
const CardViewerModal = ({ card, versions, onClose, canShare = false, pack }: CardViewerModalProps) => {
  const [shown, setShown] = useState<CardVersion>(() => versions?.[0]?.version ?? versionOf(card));
  const { isHolo, finish, misprint } = shown;
  const label = modifierLabel(shown, false);
  const [sharing, setSharing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    // A real mouse only (phones send a mousemove with every tap, and touchmove while scrolling).
    // No tilt under reduced motion, and turning it on while the close-up is open stops it at once.
    if (reducedMotion || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const onMove = (clientX: number, clientY: number) => {
      const rect = cardRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = Math.max(-1.5, Math.min(1.5, (clientX - (rect.left + rect.width / 2)) / (rect.width / 2)));
      const py = Math.max(-1.5, Math.min(1.5, (clientY - (rect.top + rect.height / 2)) / (rect.height / 2)));
      setTilt({ x: -py * MAX_TILT, y: px * MAX_TILT });
    };
    const mouse = (e: MouseEvent) => onMove(e.clientX, e.clientY);
    window.addEventListener('mousemove', mouse);
    // data-tilt="live" marks the moment the card follows the mouse. The listener attaches in a
    // passive effect, after the render that shows the card, so a mouse move just before it is lost.
    const el = cardRef.current;
    el?.setAttribute('data-tilt', 'live');
    return () => {
      window.removeEventListener('mousemove', mouse);
      el?.removeAttribute('data-tilt');
    };
  }, [reducedMotion]);
  // Turning reduced motion on levels the card and forgets the angle, so turning it back off doesn't
  // snap the card to where the mouse last was.
  if (reducedMotion && (tilt.x !== 0 || tilt.y !== 0)) setTilt({ x: 0, y: 0 });

  return (
    <Sheet title={card.name} onClose={onClose} bare className="card-viewer">
      <div
        ref={cardRef}
        className={`card-viewer-card ${card.rarity.toLowerCase()} ${isHolo ? 'holo' : ''} ${modifierClasses(shown)}`}
        style={{ transform: `perspective(1000px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` }}
      >
        <CardImage src={card.image} finish={finish} alt={card.name} draggable="false" retry />
        {misprint && <CardImage src={card.image} finish={finish} alt="" aria-hidden="true" className="misprint-ghost" draggable="false" />}
        {label && <span className="modifier-sticker">{label}</span>}
      </div>
      <div className="card-viewer-info">
        <CardVersionStats card={card} version={shown} />
        {card.flavor && <p className="card-viewer-flavor">{card.flavor}</p>}
        {versions && versions.length > 1 && (
          <div className="card-viewer-versions" role="group" aria-label="Your versions of this card">
            <span className="card-viewer-versions-label">Your versions</span>
            <span className="card-viewer-chips">
              {versions.map(({ version, count }) => (
                <button
                  key={versionName(version)}
                  type="button"
                  className={`version-chip ${version.misprint ? 'misprint-chip' : ''} ${version.uncertain ? 'uncertain-chip' : ''}`}
                  style={version.finish ? ({ '--finish': FINISH_INFO[version.finish].color } as React.CSSProperties) : undefined}
                  aria-pressed={sameVersion(shown, version)}
                  onClick={() => setShown(version)}
                >
                  {versionName(version)} ×{count}
                  <span className="sr-only">, {cardPoints(card.rarity, version.isHolo, version.finish, version.misprint).toLocaleString()} points</span>
                </button>
              ))}
            </span>
          </div>
        )}
        <div className="card-viewer-actions">
          {/* A version rebuilt from tallies may be a guess: never share it as an exact pull. */}
          {canShare && !shown.uncertain && (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => setSharing(true)}>
              <Share2 aria-hidden="true" /> Share card
            </button>
          )}
        </div>
      </div>
      {sharing && <DeferredSheet load={loadCardShare} title={`Share ${card.name}`} screenProps={{ card, version: shown, from: pack, onClose: () => setSharing(false) }} />}
    </Sheet>
  );
};

export default CardViewerModal;
