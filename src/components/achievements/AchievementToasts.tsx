import { useEffect, useRef, useState } from 'react';
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
   * its title or close button. A toast already up fades out and comes back in full afterwards; none
   * is dropped.
   */
  paused?: boolean;
  /**
   * Hold them the same way while a big pull is on show, so none lands in its screenshot. Here a toast
   * already up leaves at once, with no fade over the card.
   */
  held?: boolean;
}

/** At this many waiting unlocks, show one grouped toast instead of a long run of single ones. */
const GROUP_AT = 3;

/**
 * How long a toast stays up (WCAG 2.2.1: time to read, decide and tap, not a glance). Hovering or
 * focusing it holds it until the pointer or focus leaves, and then it gets its full time again.
 */
export const TOAST_MS = 8000;
export const GROUPED_TOAST_MS = 10_000;

/**
 * Achievement unlocks, one small toast at a time at the top of the screen. A burst (one lucky pack
 * can unlock seven) becomes a single "N achievements" toast rather than a wall over the game.
 */
const AchievementToasts = ({ queue, onDismiss, onOpen, paused = false, held = false }: AchievementToastsProps) => {
  // Level-ups and the like go one at a time; a run of achievements at the front can be grouped.
  const leadingAchievements = queue.findIndex((t) => t.kicker) === -1 ? queue : queue.slice(0, queue.findIndex((t) => t.kicker));
  const grouped = leadingAchievements.length >= GROUP_AT;
  const shown = grouped ? leadingAchievements : queue.slice(0, 1);
  const key = paused || held ? '' : shown.map((a) => a.id).join('|');
  // A toast fading out has already been put back in the queue, so a tap on it does nothing.
  const liveKey = useRef(key);
  // The toast (by key) the pointer or focus is on: its timer waits. Cleared when none is up, since a
  // toast that unmounts under the pointer never gets its leave event.
  const [pointerOn, setPointerOn] = useState('');
  const [focusOn, setFocusOn] = useState('');
  if (!key && pointerOn) setPointerOn('');
  if (!key && focusOn) setFocusOn('');
  const holding = !!key && (pointerOn === key || focusOn === key);
  useEffect(() => {
    liveKey.current = key;
  }, [key]);

  useEffect(() => {
    if (!key || holding) return;
    const timer = window.setTimeout(() => onDismiss(key.split('|')), grouped ? GROUPED_TOAST_MS : TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [key, grouped, holding, onDismiss]);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {/* Unmounted while held, so a toast on screen goes at once instead of fading over the showcase. */}
      {!held && (
        <AnimatePresence mode="wait">
          {key && (
            <motion.button
              key={key}
              type="button"
              className={`toast ${!grouped && shown[0].kicker ? 'toast--detail' : ''}`}
              onPointerEnter={() => setPointerOn(key)}
              onPointerLeave={() => setPointerOn('')}
              onFocus={() => setFocusOn(key)}
              onBlur={() => setFocusOn('')}
              onClick={() => {
                if (liveKey.current !== key) return;
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
