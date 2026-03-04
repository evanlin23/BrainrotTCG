import { useEffect } from 'react';
import { motion } from 'framer-motion';
import '../../styles/Achievements.css';
import type { Achievement } from '../../data/achievements';

interface AchievementNotificationProps {
    achievement: Achievement;
    onDismiss: () => void;
    index?: number;
}

const AchievementNotification = ({ achievement, onDismiss, index = 0 }: AchievementNotificationProps) => {
    useEffect(() => {
        const timer = setTimeout(() => {
            onDismiss();
        }, 4000);

        return () => {
            clearTimeout(timer);
        };
    }, [onDismiss]);

    return (
        <motion.div
            className="achievement-notification"
            initial={{ x: 300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 300, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 200, damping: 20 }}
            style={{ top: `calc(1rem + ${index * 110}px)` }}
            layout
        >
            <div className="achievement-notification-icon">{achievement.icon}</div>
            <div className="achievement-notification-content">
                <div className="achievement-notification-title">Achievement Unlocked!</div>
                <div className="achievement-notification-name">{achievement.name}</div>
                <div className="achievement-notification-desc">{achievement.description}</div>
            </div>
        </motion.div>
    );
};

export default AchievementNotification;
