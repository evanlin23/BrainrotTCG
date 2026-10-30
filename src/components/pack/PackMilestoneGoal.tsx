import type { NextMilestoneGoal } from '../../game/nextMilestone';
import '../../styles/PackMilestone.css';

export interface PackMilestoneGoalProps {
  goal: NextMilestoneGoal;
  onNavigate: (target: 'rewards' | 'cards') => void;
  disabled?: boolean;
}

/**
 * One goal as a single line in the Card guide's row (see PackMilestone.css): the thing to chase, how
 * far along it is, and, when there is somewhere to go, a link to it. Nothing in it moves.
 */
const PackMilestoneGoal = ({ goal, onNavigate, disabled = false }: PackMilestoneGoalProps) => {
  const { action } = goal;
  const label = `Next goal: ${goal.targetName}, ${goal.progressText}. ${goal.detail}.${action ? ` ${action.text}.` : ''}`;
  const body = (
    <>
      <span className="pack-milestone-text">
        <strong className="pack-milestone-target">{goal.targetName}</strong>
        <span className="pack-milestone-detail" aria-hidden="true"> · {goal.detail}</span>
      </span>
      <span className="pack-milestone-progress" aria-hidden="true">{goal.progressText}</span>
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
      title={`${goal.targetName}: ${goal.detail}`}
      disabled={disabled}
      onClick={() => onNavigate(action.target)}
    >
      {body}
    </button>
  ) : (
    <div className="pack-milestone" role="group" aria-label={label} title={`${goal.targetName}: ${goal.detail}`}>
      {body}
    </div>
  );
};

export default PackMilestoneGoal;
