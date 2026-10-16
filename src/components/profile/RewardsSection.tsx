import { useState } from 'react';
import { CARD_BACKS, PACK_FOILS } from '../../game/progression';
import { packImageUrl } from '../../content/art';
import { DEFAULT_SET_ID } from '../../content/sets';
import type { Settings } from '../../types';
import RewardsPanel from './RewardsPanel';
import PackCacheNote from './PackCacheNote';
import '../../styles/Pulls.css';
import '../../styles/Profile.css';

const REWARDS = [...CARD_BACKS, ...PACK_FOILS];

interface RewardsSectionProps {
  /** Null while saved packs are still being read (or couldn't be). */
  level: number | null;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  /** Changes each time something asks for this section (a level-up toast), which opens it. */
  openRequest?: number;
}

/** "N of M unlocked", or that every card back and foil is. */
const rewardsSummary = (level: number): string => {
  const unlocked = REWARDS.filter((r) => r.level <= level).length;
  return unlocked === REWARDS.length ? 'Every reward unlocked' : `${unlocked} of ${REWARDS.length} unlocked`;
};

/** The card backs and pack foils your level unlocked, folded away until asked for. */
export default function RewardsSection({ level, settings, onSettingsChange, openRequest }: RewardsSectionProps) {
  const [open, setOpen] = useState(openRequest !== undefined);
  const [seenRequest, setSeenRequest] = useState(openRequest);
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    if (openRequest !== undefined) setOpen(true);
  }
  return (
    <section id="rewards" className="profile-section profile-rewards" aria-labelledby="rewards-title">
      <h2 id="rewards-title" className="section-title profile-heading" tabIndex={-1}>Card back and foil</h2>
      {level === null ? (
        <PackCacheNote what="your card backs and foils" />
      ) : (
        <details className="profile-disclosure" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>{rewardsSummary(level)}</summary>
          <RewardsPanel level={level} settings={settings} onSettingsChange={onSettingsChange} packImage={packImageUrl(DEFAULT_SET_ID)} />
        </details>
      )}
    </section>
  );
}
