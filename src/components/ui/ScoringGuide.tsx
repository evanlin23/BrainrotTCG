import { useMemo } from 'react';
import {
  FINISHES_RAREST_FIRST,
  FINISH_MULTIPLIER,
  HOLO_MULTIPLIER,
  MISPRINT_MULTIPLIER,
  MODIFIERS_V1,
  ODDS_TOTAL,
  POKER_HANDS,
  RARITIES_RAREST_FIRST,
  RARITY_POINTS,
  handOdds,
  oneIn,
  type HandKey,
  type SetDefinition,
} from '../../engine';
import { CARD_RARITIES } from '../../data/cards';
import { FINISH_INFO } from '../../game/modifiers';
import RarityBadge from './RarityBadge';
import Sheet from './Sheet';
import '../../styles/Scoring.css';

interface ScoringGuideProps {
  set: SetDefinition;
  onClose: () => void;
}

const HAND_ORDER: HandKey[] = ['PAIR', 'TWO_PAIR', 'THREE_OF_A_KIND', 'FULL_HOUSE', 'FOUR_OF_A_KIND', 'FIVE_OF_A_KIND'];

const formatOneIn = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString());

/** "Silver up to Diamond": the commonest finish to the rarest. */
const FINISH_RANGE = `${FINISH_INFO[FINISHES_RAREST_FIRST[FINISHES_RAREST_FIRST.length - 1]].name} up to ${FINISH_INFO[FINISHES_RAREST_FIRST[0]].name}`;

/** A per-card chance in basis points, as the tables show it: "2.5%". */
const formatPerCard = (basisPoints: number) => `${(basisPoints / 100).toLocaleString()}%`;

/** The finish the worked example uses. */
const EXAMPLE_FINISH = 'GOLD' as const;

/** The card guide: what makes a card rare or special, and how Brainrot Score works, with the exact odds for this set. */
const ScoringGuide = ({ set, onClose }: ScoringGuideProps) => {
  const odds = useMemo(() => handOdds(set), [set]);
  const rarities = [...RARITIES_RAREST_FIRST].reverse().filter((r) => set.odds[r] > 0);
  const commonest = rarities[0];
  const rarest = rarities[rarities.length - 1];
  const hasModifiers = set.modifiers === 1;
  const finishName = FINISH_INFO[EXAMPLE_FINISH].name;
  // The worked example: holo and a finish are separate per-card rolls, so their chances multiply,
  // apart from the rarity roll; points multiply the same way.
  const exampleModifierChance = (set.holoOdds / ODDS_TOTAL) * (hasModifiers ? MODIFIERS_V1.finishOdds[EXAMPLE_FINISH] / ODDS_TOTAL : 1);
  const exampleMultiplier = HOLO_MULTIPLIER * (hasModifiers ? FINISH_MULTIPLIER[EXAMPLE_FINISH] : 1);

  return (
    <Sheet title="Card guide" subtitle={`Rarity, modifiers and scoring for ${set.name}`} onClose={onClose} size="sm" className="scoring-guide">
        <h3>Rare, holo or special?</h3>
        <p className="scoring-note">
          <strong>Rarity</strong> is which card you pulled, from {CARD_RARITIES[commonest].name} up to {CARD_RARITIES[rarest].name}. Rarer cards are worth more points.
        </p>
        <p className="scoring-note">
          <strong>Holo</strong> is a shiny copy that any card can roll, whatever its rarity. It multiplies that card&apos;s points.
        </p>
        {hasModifiers && (
          <p className="scoring-note">
            <strong>Finishes</strong> ({FINISH_RANGE}) and <strong>misprints</strong> are rarer extras. A card gets one finish at most.
          </p>
        )}
        {set.modifiers === undefined && (
          <p className="scoring-note">{set.name} has no finishes or misprints: only rarity and holo.</p>
        )}
        <p className="scoring-note">
          Each card rolls its rarity{hasModifiers ? ', holo, finish and misprint' : ' and holo'} separately, so any card can get any mix. Its points multiply: rarity points × holo{hasModifiers ? ' × finish × misprint' : ''}.
        </p>

        <h3>Brainrot Score</h3>
        <p className="scoring-formula">
          Brainrot Score = <strong>card points</strong> added up × <strong>combo multiplier</strong>
        </p>

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

        {hasModifiers && (
          <>
            <h3>Finishes and misprints</h3>
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
            <p className="scoring-note">
              Misprint stacks on any finish: {finishName} Misprint = ×{FINISH_MULTIPLIER[EXAMPLE_FINISH].toLocaleString()} × {MISPRINT_MULTIPLIER.toLocaleString()} = ×{(FINISH_MULTIPLIER[EXAMPLE_FINISH] * MISPRINT_MULTIPLIER).toLocaleString()}.
            </p>
          </>
        )}

        <h3>Example: a holo{hasModifiers ? ` ${finishName}` : ''} card</h3>
        <p className="scoring-note">
          About 1 in {formatOneIn(oneIn(exampleModifierChance))} cards is {hasModifiers ? 'both ' : ''}Holo ({formatPerCard(set.holoOdds)}){hasModifiers ? <> and {finishName} ({formatPerCard(MODIFIERS_V1.finishOdds[EXAMPLE_FINISH])})</> : null}, at any rarity.
        </p>
        <p className="scoring-formula">
          {CARD_RARITIES[commonest].name} {RARITY_POINTS[commonest].toLocaleString()} × holo {HOLO_MULTIPLIER}
          {hasModifiers ? ` × ${finishName} ${FINISH_MULTIPLIER[EXAMPLE_FINISH].toLocaleString()}` : ''} = <strong>{(RARITY_POINTS[commonest] * exampleMultiplier).toLocaleString()} points</strong>
        </p>

        <h3>Combos</h3>
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
