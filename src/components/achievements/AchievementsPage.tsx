import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ACHIEVEMENTS } from '../../data/achievements';
import type { AchievementData } from '../../types';
import type { CardWithMeta } from '../cards/Card';
import PackCardViewer from '../ui/PackCardViewer';
import '../../styles/Achievements.css';

interface AchievementsPageProps {
    unlockedAchievements: Record<string, AchievementData | number>;
    onClose: () => void;
}

// Helper to get achievement data in new format
const getAchievementData = (data: AchievementData | number | undefined): { unlockedAt: number; pack?: CardWithMeta[] } | null => {
    if (!data) return null;
    if (typeof data === 'number') {
        return { unlockedAt: data };
    }
    return data;
};

const AchievementsPage = ({ unlockedAchievements, onClose }: AchievementsPageProps) => {
    const [selectedPack, setSelectedPack] = useState<CardWithMeta[] | null>(null);

    const unlockedCount = Object.keys(unlockedAchievements).length;

    return (
        <div className="achievements-page">
            <div className="achievements-header">
                <h2>Achievements</h2>
                <p>{unlockedCount} / {ACHIEVEMENTS.length} unlocked</p>
                <button className="achievements-close-btn" onClick={onClose}>×</button>
            </div>

            <div className="achievements-grid">
                {ACHIEVEMENTS.map(achievement => {
                    const achievementData = getAchievementData(unlockedAchievements[achievement.id]);
                    const unlocked = !!achievementData;
                    const unlockedDate = achievementData ? new Date(achievementData.unlockedAt).toLocaleDateString() : null;
                    const hasPack = achievementData?.pack && achievementData.pack.length > 0;

                    return (
                        <div
                            key={achievement.id}
                            className={`achievement-card ${unlocked ? 'unlocked' : 'locked'} ${hasPack ? 'has-pack' : ''}`}
                            onClick={() => hasPack && setSelectedPack(achievementData!.pack!)}
                        >
                            <div className="achievement-icon">{achievement.icon}</div>
                            <div className="achievement-info">
                                <div className="achievement-name">{achievement.name}</div>
                                <div className="achievement-description">{achievement.description}</div>
                                {unlockedDate && (
                                    <div className="achievement-date">Unlocked: {unlockedDate}</div>
                                )}
                                {hasPack && (
                                    <div className="achievement-pack-hint">Click to view pack</div>
                                )}
                            </div>
                            {unlocked && <div className="achievement-check">✓</div>}
                        </div>
                    );
                })}
            </div>

            {/* Pack Viewer Modal - rendered via portal to avoid scroll issues */}
            {selectedPack && createPortal(
                <div className="achievement-pack-modal" onClick={() => setSelectedPack(null)}>
                    <div className="achievement-pack-content" onClick={e => e.stopPropagation()}>
                        <button className="achievement-pack-close" onClick={() => setSelectedPack(null)}>×</button>
                        <h3>Pack that unlocked this achievement</h3>
                        <PackCardViewer cards={selectedPack} displayMode="grid" />
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};

export default AchievementsPage;
