import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import CardBackSwatch from '../ui/CardBackSwatch';
import { CARD_BACKS, PACK_FOILS, nextReward, usable, type Reward } from '../../game/progression';
import type { Settings } from '../../types';
import '../../styles/Profile.css';

interface RewardsPanelProps {
  level: number;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  /** A pack wrapper to show the foils on. */
  packImage: string;
}

/** What your level has unlocked: pick a card back and a pack foil; the next unlock is named. */
const RewardsPanel = ({ level, settings, onSettingsChange, packImage }: RewardsPanelProps) => {
  const next = nextReward(level);
  return (
    <div className="rewards">
      <p className="rewards-next">
        {next ? (
          <>
            Next: <strong>{next.name}</strong> ({next.kind}) at level {next.level}
          </>
        ) : (
          'Every reward unlocked.'
        )}
      </p>
      <RewardPicker
        label="Card back"
        rewards={CARD_BACKS}
        chosen={usable(CARD_BACKS, settings.cardBack, level)}
        level={level}
        onChoose={(cardBack) => onSettingsChange({ ...settings, cardBack })}
        preview={(r) => <CardBackSwatch id={r.id} />}
      />
      <RewardPicker
        label="Pack foil"
        rewards={PACK_FOILS}
        chosen={usable(PACK_FOILS, settings.packFoil, level)}
        level={level}
        onChoose={(packFoil) => onSettingsChange({ ...settings, packFoil })}
        preview={(r) => (
          <span className={`foil-swatch foil-${r.id}`} style={{ '--pack-mask': `url("${packImage}")` } as React.CSSProperties}>
            <img src={packImage} alt="" draggable="false" />
          </span>
        )}
      />
    </div>
  );
};

interface RewardPickerProps {
  label: string;
  rewards: readonly Reward[];
  chosen: string;
  level: number;
  onChoose: (id: string) => void;
  preview: (reward: Reward) => ReactNode;
}

/**
 * One kind of reward as a row of choices; locked ones show the level that unlocks them. A radio
 * group: one Tab stop (the chosen one), and the arrow keys move between the unlocked choices.
 */
const RewardPicker = ({ label, rewards, chosen, level, onChoose, preview }: RewardPickerProps) => {
  const open = rewards.filter((r) => r.level <= level);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step || open.length === 0) return;
    event.preventDefault();
    const at = Math.max(0, open.findIndex((r) => r.id === chosen));
    const next = open[(at + step + open.length) % open.length];
    onChoose(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-reward="${next.id}"]`)?.focus();
  };
  return (
    <div className="reward-picker" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      <span className="reward-picker-label">{label}</span>
      <div className="reward-options">
        {rewards.map((r) => {
          const locked = r.level > level;
          return (
            <button
              key={r.id}
              type="button"
              role="radio"
              data-reward={r.id}
              aria-checked={r.id === chosen}
              tabIndex={r.id === chosen ? 0 : -1}
              className={`reward-option ${locked ? 'is-locked' : ''}`}
              disabled={locked}
              onClick={() => onChoose(r.id)}
              aria-label={locked ? `${r.name}, unlocks at level ${r.level}` : r.name}
            >
              {preview(r)}
              <span className="reward-option-name">
                {locked && <Lock aria-hidden="true" />}
                {locked ? `Lv ${r.level}` : r.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default RewardsPanel;
