import ProfileSection from './ProfileSection';
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
  return (
    <ProfileSection id="rewards" title="Card back and foil" titleId="rewards-title" className="profile-section profile-rewards" note={level === null ? 'Loading…' : rewardsSummary(level)} openRequest={openRequest}>
      {level === null ? (
        <PackCacheNote what="your card backs and foils" />
      ) : (
        <RewardsPanel level={level} settings={settings} onSettingsChange={onSettingsChange} packImage={packImageUrl(DEFAULT_SET_ID)} />
      )}
    </ProfileSection>
  );
}
