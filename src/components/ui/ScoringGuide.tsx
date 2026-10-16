import { useMemo } from 'react';
import {
  FINISHES_RAREST_FIRST,
  FINISH_MULTIPLIER,
  HOLO_MULTIPLIER,
  MISPRINT_MULTIPLIER,
  MODIFIERS_V1,
  POKER_HANDS,
  RARITIES_RAREST_FIRST,
  RARITY_POINTS,
  handOdds,
  oneIn,
  type HandKey,
  type SetDefinition,
} from '../../engine';
import { CARD_RARITIES } from '../../data/cards';
import { FINISH_INFO, specialPackChance } from '../../game/modifiers';
import RarityBadge from './RarityBadge';
import Sheet from './Sheet';
import '../../styles/Scoring.css';

interface ScoringGuideProps {
  set: SetDefinition;
  onClose: () => void;
}

const HAND_ORDER: HandKey[] = ['PAIR', 'TWO_PAIR', 'THREE_OF_A_KIND', 'FULL_HOUSE', 'FOUR_OF_A_KIND', 'FIVE_OF_A_KIND'];

const formatOneIn = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString());

/** "About 63%", or one decimal place under 1%. */
const formatChance = (p: number) => {
  const percent = p * 100;
  return `${percent >= 1 ? Math.round(percent) : percent.toFixed(1)}%`;
};

/** The card guide: what makes a card rare or special, and how Brainrot Score works, with the exact odds for this set. */
const ScoringGuide = ({ set, onClose }: ScoringGuideProps) => {
  const odds = useMemo(() => handOdds(set), [set]);
  const rarities = [...RARITIES_RAREST_FIRST].reverse().filter((r) => set.odds[r] > 0);
  const commonest = rarities[0];
  const rarest = rarities[rarities.length - 1];

  return (
    <Sheet title="Card guide" subtitle={`Rarity, modifiers and scoring for ${set.name}`} onClose={onClose} size="sm" className="scoring-guide">
        <h3>Rare, holo or special?</h3>
        <p className="scoring-note">
          <strong>Rarity</strong> is which card you pulled, from {CARD_RARITIES[commonest].name} up to {CARD_RARITIES[rarest].name}. Rarer cards are worth more points.
        </p>
        <p className="scoring-note">
          <strong>Holo</strong> is a shiny copy that any card can roll, whatever its rarity. It multiplies that card&apos;s points.
        </p>
        {set.modifiers === 1 && (
          <p className="scoring-note">
            <strong>Finishes</strong> (Silver up to Diamond) and <strong>misprints</strong> are rarer extras on top. They stack with holo and with each other.
          </p>
        )}
        <p className="scoring-note">
          Holo{set.modifiers === 1 ? ', finished and misprinted cards are' : ' cards are'} special cards: about {formatChance(specialPackChance(set))} of packs have at least one.
        </p>

        <h3>Brainrot Score</h3>
        <p className="scoring-formula">
          Brainrot Score = <strong>card points</strong> × <strong>combo multiplier</strong>
        </p>
        <p className="scoring-note">Rarer always pays more: every number comes from the odds. Odds below are exact for {set.name}.</p>

        <h3>Card rarity</h3>
        <table className="scoring-table">
          <thead>
            <tr><th>Rarity</th><th>Chance per card</th><th>Points</th></tr>
          </thead>
          <tbody>
            {rarities.map((r) => (
              <tr key={r}>
                <td><RarityBadge rarity={r} showPoints={false} /></td>
                <td>{(set.odds[r] / 100).toLocaleString()}%</td>
                <td>{RARITY_POINTS[r].toLocaleString()}</td>
              </tr>
            ))}
            <tr>
              <td><span className="rarity-pill holo-pill"><span className="rarity-pill-gem" aria-hidden="true">◆</span>Holo</span></td>
              <td>{(set.holoOdds / 100).toLocaleString()}%</td>
              <td>×{HOLO_MULTIPLIER} points</td>
            </tr>
          </tbody>
        </table>

        {set.modifiers === 1 && (
          <>
            <h3>Finishes and misprints (they all stack)</h3>
            <table className="scoring-table">
              <thead>
                <tr><th>Modifier</th><th>Chance per card</th><th>Points</th></tr>
              </thead>
              <tbody>
                {[...FINISHES_RAREST_FIRST].reverse().map((f) => (
                  <tr key={f}>
                    <td><span className="finish-pill" style={{ '--finish': FINISH_INFO[f].color } as React.CSSProperties}>{FINISH_INFO[f].name}</span></td>
                    <td>{(MODIFIERS_V1.finishOdds[f] / 100).toLocaleString()}%</td>
                    <td>×{FINISH_MULTIPLIER[f].toLocaleString()}</td>
                  </tr>
                ))}
                <tr>
                  <td><span className="finish-pill misprint-pill">Misprint</span></td>
                  <td>{(MODIFIERS_V1.misprintOdds / 100).toLocaleString()}%</td>
                  <td>×{MISPRINT_MULTIPLIER}</td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        <h3>Combos (same card more than once)</h3>
        <table className="scoring-table">
          <thead>
            <tr><th>Combo</th><th>Chance per pack</th><th>Multiplier</th></tr>
          </thead>
          <tbody>
            {HAND_ORDER.map((h) => (
              <tr key={h}>
                <td>{POKER_HANDS[h].name}</td>
                <td>1 in {formatOneIn(oneIn(odds[h]))}</td>
                <td>×{POKER_HANDS[h].multiplier.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
    </Sheet>
  );
};

export default ScoringGuide;
