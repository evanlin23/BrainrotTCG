/**
 * #1138 exploration: the drawn parts of the draft card and pack directions (game/designLook.ts).
 * Every piece is hidden (styles/looks/looks.css) until <html> carries a `data-look`, so the current
 * look renders exactly as before. The pieces are decoration: the card image's alt text and the pack
 * button's name already say what they show, so all of it is hidden from assistive tech.
 */
import type { CSSProperties } from 'react';
import type { SetDefinition } from '../../engine';
import { setColours } from './lookColours';
import { getLatestSet, setCode } from '../../content/sets';
import { CARD_RARITIES, cardNumber } from '../../data/cards';
import type { CardWithMeta } from '../../types/card';
import { modifierLabel } from '../../game/modifiers';
import { LOGO_MARK_PATH, LOGO_MARK_VIEWBOX } from '../../styles/logoMark';
// The shared scaffolding first, then each look, so a look's rules win ties with the shared ones.
import '../../styles/looks/looks.css';
import '../../styles/looks/look-a.css';
import '../../styles/looks/look-b.css';
import '../../styles/looks/look-c.css';

const LookMark = ({ className }: { className: string }) => (
  <svg className={className} viewBox={LOGO_MARK_VIEWBOX} aria-hidden="true" focusable="false">
    <path fill="currentColor" d={LOGO_MARK_PATH} />
  </svg>
);

/** The printed parts of a face in a draft look: name, rarity, caption and collector line. */
export const CardFaceFrame = ({ card }: { card: CardWithMeta }) => {
  const rarity = CARD_RARITIES[card.rarity];
  const set = getLatestSet(card.setId);
  const modifiers = modifierLabel(card);
  return (
    <div className="lk-face" aria-hidden="true">
      {/* Its length sizes the name to fit one line (looks.css), as the printed frame fits its banner today. */}
      <span className="lk-name" style={{ '--name-len': Math.max(card.name.length, 8) } as CSSProperties}>{card.name}</span>
      <span className="lk-rarity">
        <span className="lk-rarity-symbol">{rarity.symbol}</span>
        <span className="lk-rarity-name">{rarity.name}</span>
      </span>
      {modifiers && <span className="lk-finish">{modifiers}</span>}
      <span className="lk-caption">{card.caption ?? card.flavor ?? ''}</span>
      <span className="lk-foot">
        <span className="lk-code">{set ? setCode(set) : ''}</span>
        <span className="lk-number">{cardNumber(card)}</span>
        <LookMark className="lk-foot-mark" />
      </span>
    </div>
  );
};

/** A card back in a draft look. Its colours come from the chosen back (data-card-back or .back-*). */
export const CardBackArt = () => (
  <div className="lk-back" aria-hidden="true">
    <span className="lk-back-pattern" />
    <span className="lk-back-medal">
      <LookMark className="lk-back-mark" />
    </span>
    <span className="lk-back-word">Brainrot TCG</span>
  </div>
);

/** A sealed pack wrapper in a draft look, drawn from the set's colours and name: no image to fetch. */
export const PackWrapperArt = ({ set }: { set: SetDefinition }) => (
  <div className="lk-pack" aria-hidden="true" style={setColours(set)}>
    <span className="lk-pack-ground" />
    <span className="lk-pack-crimp lk-pack-crimp-top" />
    <span className="lk-pack-crimp lk-pack-crimp-bottom" />
    <span className="lk-pack-brand">
      <LookMark className="lk-pack-mark" />
      <span className="lk-pack-word">Brainrot TCG</span>
    </span>
    <span className="lk-pack-burst">
      <span>{set.packSize}</span>
      <span>cards</span>
    </span>
    <span className="lk-pack-label">
      <span className="lk-pack-name">{set.name}</span>
      <span className="lk-pack-era">{set.era}</span>
    </span>
  </div>
);
