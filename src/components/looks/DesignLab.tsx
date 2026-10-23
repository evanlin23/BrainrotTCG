/**
 * #1138 exploration: a page of real Card components (fronts and backs) for comparing the draft looks
 * (game/designLook.ts) side by side. Built only with DESIGN_LAB=1 (vite.config.ts); never deployed.
 */
import Card, { type CardWithMeta } from '../cards/Card';
import { ALL_CARDS } from '../../data/cards';
import { DEFAULT_SET_ID } from '../../content/sets';
import '../../styles/looks/designLab.css';

type Printed = (typeof ALL_CARDS)[number];
const inSet = ALL_CARDS.filter((card) => card.setId === DEFAULT_SET_ID);
const pick = (rarity: Printed['rarity']): Printed => inSet.find((card) => card.rarity === rarity) ?? inSet[0];
const dealt = (card: Printed, extra: Partial<CardWithMeta>, uniqueId: number): CardWithMeta =>
  ({ ...card, uniqueId, isRevealed: true, isHolo: false, ...extra });

const fronts: [string, CardWithMeta][] = [
  ['Common', dealt(pick('COMMON'), {}, 1)],
  ['Legendary', dealt(pick('LEGENDARY'), {}, 2)],
  ['Rare, gold finish', dealt(pick('RARE'), { finish: 'GOLD' }, 3)],
  ['Epic, holo', dealt(pick('EPIC'), { isHolo: true }, 4)],
];
const backs: [string, string][] = [
  ['Default back', 'back-classic'],
  ['Unlockable: gold', 'back-gold'],
  ['Unlockable: midnight', 'back-midnight'],
];

const DesignLab = () => (
  <main className="design-lab">
    {fronts.map(([label, card]) => (
      <figure key={label} className="lab-front">
        <Card card={card} isFlipped onFlip={() => {}} />
        <figcaption>{label}</figcaption>
      </figure>
    ))}
    {backs.map(([label, className]) => (
      <figure key={label} className={className}>
        <Card card={fronts[0][1]} isFlipped={false} onFlip={() => {}} />
        <figcaption>{label}</figcaption>
      </figure>
    ))}
  </main>
);

export default DesignLab;
