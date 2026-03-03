import { ACHIEVEMENTS } from '../data/achievements';
import '../styles/Achievements.css';

interface AchievementsPageProps {
    unlockedAchievements: Record<string, number>;
    onClose: () => void;
}

const AchievementsPage = ({ unlockedAchievements, onClose }: AchievementsPageProps) => {
    return (
        <div className="achievements-page">
            <div className="achievements-header">
                <h2>Achievements</h2>
                <p>{Object.keys(unlockedAchievements).length} / {ACHIEVEMENTS.length} unlocked</p>
                <button className="achievements-close-btn" onClick={onClose}>×</button>
            </div>

            <div className="achievements-grid">
                {ACHIEVEMENTS.map(achievement => {
                    const unlocked = unlockedAchievements[achievement.id];
                    const unlockedDate = unlocked ? new Date(unlocked).toLocaleDateString() : null;

                    return (
                        <div
                            key={achievement.id}
                            className={`achievement-card ${unlocked ? 'unlocked' : 'locked'}`}
                        >
                            <div className="achievement-icon">{achievement.icon}</div>
                            <div className="achievement-info">
                                <div className="achievement-name">{achievement.name}</div>
                                <div className="achievement-description">{achievement.description}</div>
                                {unlockedDate && (
                                    <div className="achievement-date">Unlocked: {unlockedDate}</div>
                                )}
                            </div>
                            {unlocked && <div className="achievement-check">✓</div>}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default AchievementsPage;
