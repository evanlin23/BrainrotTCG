import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import '../../styles/Achievements.css';
import type { Achievement } from '../../data/achievements';

interface AchievementNotificationProps {
    achievement: Achievement;
    onDismiss: () => void;
    index?: number;
}

const AchievementNotification = ({ achievement, onDismiss, index = 0 }: AchievementNotificationProps) => {
    const [isVisible, setIsVisible] = useState(true);

    useEffect(() => {
        let dismissTimer: ReturnType<typeof setTimeout>;
        const timer = setTimeout(() => {
            setIsVisible(false);
            dismissTimer = setTimeout(onDismiss, 300); // Wait for exit animation
        }, 4000);

        return () => {
            clearTimeout(timer);
            if (dismissTimer) clearTimeout(dismissTimer);
        };
    }, [onDismiss]);

    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    className="achievement-notification"
                    initial={{ x: 300, opacity: 0 }}
                    animate={{ x: 0, opacity: 1, y: index * 110 }}
                    exit={{ x: 300, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 20 }}
                    style={{ top: `1rem` }}
                >
                    <div className="achievement-notification-icon">{achievement.icon}</div>
                    <div className="achievement-notification-content">
                        <div className="achievement-notification-title">Achievement Unlocked!</div>
                        <div className="achievement-notification-name">{achievement.name}</div>
                        <div className="achievement-notification-desc">{achievement.description}</div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default AchievementNotification;
