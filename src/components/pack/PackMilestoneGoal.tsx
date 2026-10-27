import type { NextMilestoneGoal } from '../../game/nextMilestone';
import '../../styles/PackMilestone.css';

export interface PackMilestoneGoalProps {
  goal: NextMilestoneGoal;
  onNavigate: (target: 'rewards' | 'cards') => void;
  disabled?: boolean;
}

const PackMilestoneGoal = ({ goal, onNavigate, disabled = false }: PackMilestoneGoalProps) => {
  return (
    <section className="pack-milestone" aria-label={`Next milestone: ${goal.targetName}`}>
      <div className="pack-milestone-header">
        <span className="pack-milestone-kicker">{goal.title}</span>
        {goal.previewBadge && <span className="pack-milestone-badge">{goal.previewBadge}</span>}
      </div>
      <div className="pack-milestone-main">
        <span className="pack-milestone-target">{goal.targetName}</span>
        <span className="pack-milestone-progress-text">{goal.progressText}</span>
      </div>
      <div
        className="pack-milestone-bar"
        role="progressbar"
        aria-valuenow={goal.progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${goal.targetName} progress`}
      >
        <div
          className="pack-milestone-bar-fill"
          style={{ width: `${Math.min(100, Math.max(0, goal.progressPct))}%` }}
        />
      </div>
      <div className="pack-milestone-footer">
        <span className="pack-milestone-detail">{goal.detail}</span>
        <button
          type="button"
          className="pack-milestone-action"
          onClick={() => onNavigate(goal.actionTarget)}
          disabled={disabled}
        >
          {goal.actionText} →
        </button>
      </div>
    </section>
  );
};

export default PackMilestoneGoal;
