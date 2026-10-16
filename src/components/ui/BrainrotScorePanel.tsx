import { DEFAULT_SET_ID, getLatestSet } from '../../content/sets';
import CardGuideButton from './CardGuideButton';
import '../../styles/Scoring.css';

interface BrainrotScorePanelProps {
  points: number;
  multiplier: number;
  /** Left out where the hand's name is already the heading above the panel. */
  handName?: string;
  score: number;
  /** Set whose odds the card guide should show. */
  setId?: string;
}

const BrainrotScorePanel = ({ points, multiplier, handName, score, setId }: BrainrotScorePanelProps) => {
  const set = getLatestSet(setId ?? DEFAULT_SET_ID) ?? getLatestSet(DEFAULT_SET_ID);
  return (
    <div className="score-panel">
      <div className="score-panel-total">{score.toLocaleString()}</div>
      <div className="score-panel-math">
        Brainrot Score
        {multiplier > 1 ? (
          <>
            {' '}· {points.toLocaleString()} pts × <strong>{multiplier.toLocaleString()}</strong>
            {handName && <> for {handName}</>}
          </>
        ) : (
          handName && <> · {handName}</>
        )}
      </div>
      {set && <CardGuideButton set={set} />}
    </div>
  );
};

export default BrainrotScorePanel;
