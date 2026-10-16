import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Award, ChevronsUp, Layers } from 'lucide-react';
import type { Achievement } from '../../data/achievements';
import '../../styles/Toasts.css';

/** An achievement, or (with a kicker) something else worth a toast, like a level-up. */
export type ToastItem = Pick<Achievement, 'id' | 'name' | 'description'> & {
  /** Replaces "Achievement unlocked"; such toasts are never grouped. */
  kicker?: string;
  /** What tapping it opens. */
  opens?: ToastTarget;
};

export type ToastTarget = 'achievements' | 'profile' | 'collection';

interface AchievementToastsProps {
  queue: ToastItem[];
  /** Remove these ids from the queue. */
  onDismiss: (ids: string[]) => void;
  /** Tapping a toast opens the achievements list, the profile for a level-up, or Cards for a kept pack. */
  onOpen: (target: ToastTarget) => void;
  /**
   * Hold the toasts, in order, until this clears: while a sheet or page is open, so they never cover
   * its title or close button, and while a big pull is on show, so none lands in its screenshot. A
   * toast already up leaves at once (no fade) and comes back in full afterwards; none is dropped.
   */
  paused?: boolean;
}

/** At this many waiting unlocks, show one grouped toast instead of a long run of single ones. */
const GROUP_AT = 3;

/**
 * Achievement unlocks, one small toast at a time at the top of the screen. A burst (one lucky pack
 * can unlock seven) becomes a single "N achievements" toast rather than a wall over the game.
 */
const AchievementToasts = ({ queue, onDismiss, onOpen, paused = false }: AchievementToastsProps) => {
  // Level-ups and the like go one at a time; a run of achievements at the front can be grouped.
  const leadingAchievements = queue.findIndex((t) => t.kicker) === -1 ? queue : queue.slice(0, queue.findIndex((t) => t.kicker));
  const grouped = leadingAchievements.length >= GROUP_AT;
  const shown = grouped ? leadingAchievements : queue.slice(0, 1);
  const key = paused ? '' : shown.map((a) => a.id).join('|');

  useEffect(() => {
    if (!key) return;
    const timer = window.setTimeout(() => onDismiss(key.split('|')), grouped ? 4500 : 3000);
    return () => window.clearTimeout(timer);
  }, [key, grouped, onDismiss]);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {/* Unmounted while paused, so a toast on screen goes at once instead of fading over the showcase. */}
      {!paused && (
        <AnimatePresence mode="wait">
          {key && (
            <motion.button
              key={key}
              type="button"
              className={`toast ${!grouped && shown[0].kicker ? 'toast--detail' : ''}`}
              onClick={() => {
                onDismiss(shown.map((a) => a.id));
                onOpen(shown[0].opens ?? 'achievements');
              }}
              initial={{ y: -12, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -8, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <span className="toast-icon" aria-hidden="true">
                {grouped || !shown[0].kicker ? <Award strokeWidth={2.4} /> : shown[0].opens === 'collection' ? <Layers strokeWidth={2.4} /> : <ChevronsUp strokeWidth={2.4} />}
              </span>
              <span className="toast-text">
                <span className="toast-kicker">{grouped ? `${shown.length} achievements unlocked` : (shown[0].kicker ?? 'Achievement unlocked')}</span>
                <span className="toast-title">
                  {grouped
                    ? shown
                        .slice(0, 3)
                        .map((a) => a.name)
                        .join(', ') + (shown.length > 3 ? ` +${shown.length - 3} more` : '')
                    : shown[0].name}
                </span>
                {!grouped && <span className="toast-desc">{shown[0].description}</span>}
              </span>
            </motion.button>
          )}
        </AnimatePresence>
      )}
    </div>
  );
};

export default AchievementToasts;
