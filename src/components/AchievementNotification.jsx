import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import '../styles/Achievements.css';

const AchievementNotification = ({ achievement, onDismiss }) => {
    const [isVisible, setIsVisible] = useState(true);

    useEffect(() => {
        const timer = setTimeout(() => {
            setIsVisible(false);
            setTimeout(onDismiss, 300); // Wait for exit animation
        }, 3000);

        return () => clearTimeout(timer);
    }, [onDismiss]);

    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    className="achievement-notification"
                    initial={{ x: 300, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: 300, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 20 }}
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
