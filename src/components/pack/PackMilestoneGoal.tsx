import type { NextMilestoneGoal } from '../../game/nextMilestone';
import CardBackSwatch from '../ui/CardBackSwatch';
import '../../styles/PackMilestone.css';

export interface PackMilestoneGoalProps {
  goal: NextMilestoneGoal;
  onNavigate: (target: 'rewards' | 'cards') => void;
  disabled?: boolean;
}

/**
 * One goal as a two-line chip in the Card guide's row (see PackMilestone.css): a picture of the reward when
 * it has one, the thing to chase and how far along it is, then a short line that says cosmetics change no
 * odds. When there is somewhere to go, the chip is the link to it. Nothing in it moves.
 */
const PackMilestoneGoal = ({ goal, onNavigate, disabled = false }: PackMilestoneGoalProps) => {
  const { action } = goal;
  const name = goal.targetKind ? `${goal.targetName} (${goal.targetKind})` : goal.targetName;
  const label = `Next goal: ${name}, ${goal.progressLabel}. ${goal.detail}.${action ? ` ${action.text}.` : ''}`;
  const body = (
    <>
      {goal.preview && <CardBackSwatch id={goal.preview.id} />}
      <span className="pack-milestone-lines">
        <span className="pack-milestone-line">
          <span className="pack-milestone-text">
            <strong className="pack-milestone-target">{goal.targetName}</strong>
            {goal.targetKind && <span className="pack-milestone-kind"> {goal.targetKind}</span>}
          </span>
          <span className="pack-milestone-progress" aria-hidden="true">{goal.progressText}</span>
        </span>
        <span className="pack-milestone-detail" aria-hidden="true">{goal.detail}</span>
      </span>
      <span className="pack-milestone-bar" aria-hidden="true">
        <span className="pack-milestone-fill" style={{ width: `${Math.min(100, Math.max(0, goal.progressPct))}%` }} />
      </span>
    </>
  );
  return action ? (
    <button
      type="button"
      className="pack-milestone"
      aria-label={label}
      title={`${name}: ${goal.detail}`}
      disabled={disabled}
      onClick={() => onNavigate(action.target)}
    >
      {body}
    </button>
  ) : (
    <div className="pack-milestone" role="group" aria-label={label} title={`${name}: ${goal.detail}`}>
      {body}
    </div>
  );
};

export default PackMilestoneGoal;
