import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, type PanInfo, type Variants } from 'framer-motion';
import { Award, ChevronsUp, Layers } from 'lucide-react';
import type { Achievement } from '../../data/achievements';
import { GROUPED_TOAST_MS, TOAST_MS, TOAST_SEEN_MS } from '../../constants/config';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
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
   * Hold the toasts, in order, until this clears: while a sheet, page or pack is open, so they never
   * cover its title, close button or cards. A toast already up fades out. One the player has had
   * TOAST_SEEN_MS to see is let go; a fresher one comes back in full afterwards. None unseen is dropped.
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
 * How long a toast stays up is TOAST_MS or GROUPED_TOAST_MS (constants/config). Hovering or
 * focusing it from the keyboard holds it until the pointer or focus leaves, and then it gets its full
 * time again. A swipe up or sideways, or Escape on the focused toast, sends it away at once.
 */
export { GROUPED_TOAST_MS, TOAST_MS };

/** A press that travels less than this is still a tap (a thumb drifts; Chrome's own click slop is about 15px). */
const TAP_SLOP = 16;
/** How far (or how fast) a swipe must go to dismiss, in px (px/s). Down is not a way out. */
const SWIPE_DISTANCE = 48;
const SWIPE_SPEED = 500;

interface Away {
  x: number;
  y: number;
}
const STAY: Away = { x: 0, y: 0 };

// A toast leaves the way it was thrown, from where the finger let go; one that times out fades up.
// With reduced motion it only fades, wherever it is sent.
const TOAST_MOTION: Variants = {
  enter: { y: -12, opacity: 0 },
  shown: { y: 0, opacity: 1 },
  leave: (away: Away) => (away.x || away.y ? { x: away.x, y: away.y, opacity: 0 } : { y: -8, opacity: 0 }),
};
const TOAST_FADE: Variants = {
  enter: { opacity: 0 },
  shown: { opacity: 1 },
  leave: { opacity: 0 },
};

/** Whether the focus on this element is the keyboard's (or the browser can't say, so it counts). */
const focusVisible = (el: HTMLElement) => {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
};

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
  const [away, setAway] = useState<Away>(STAY);
  // Set by a swipe, cleared by the click it ends in (or the next press or key): a swipe that stops short
  // is not a tap, and does not leave the toast deaf to Enter and Space.
  const swiped = useRef(false);
  const reduced = usePrefersReducedMotion();

  // The toast up now and since when. A sheet, page or pack that takes the screen after it has been seen
  // lets it go; one that arrives first only holds it. Declared before the key effect, so it still reads
  // the toast the pause is hiding.
  const upSince = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!paused) return;
    const up = upSince.current;
    upSince.current = null;
    if (up && Date.now() - up.at >= TOAST_SEEN_MS) onDismiss(up.key.split('|'));
  }, [paused, onDismiss]);
  useEffect(() => {
    liveKey.current = key;
    upSince.current = key ? { key, at: Date.now() } : null;
  }, [key]);

  useEffect(() => {
    if (!key || holding) return;
    const timer = window.setTimeout(() => {
      setAway(STAY);
      onDismiss(key.split('|'));
    }, grouped ? GROUPED_TOAST_MS : TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [key, grouped, holding, onDismiss]);

  const swipe = (info: PanInfo) => {
    const { x, y } = info.offset;
    const sideways = Math.abs(x) > Math.abs(y);
    const far = sideways ? Math.abs(x) > SWIPE_DISTANCE : y < -SWIPE_DISTANCE;
    const fast = sideways ? Math.abs(info.velocity.x) > SWIPE_SPEED && Math.abs(x) > TAP_SLOP : info.velocity.y < -SWIPE_SPEED && y < -TAP_SLOP;
    if (!far && !fast) return;
    setAway(sideways ? { x: Math.sign(x) * 240, y: 0 } : { x: 0, y: -96 });
    onDismiss(shown.map((a) => a.id));
  };

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {/* Unmounted while held, so a toast on screen goes at once instead of fading over the showcase. */}
      {!held && (
        <AnimatePresence mode="wait" custom={away}>
          {key && (
            <motion.button
              key={key}
              type="button"
              className={`toast ${!grouped && shown[0].kicker ? 'toast--detail' : ''}`}
              onPointerEnter={() => setPointerOn(key)}
              onPointerLeave={() => setPointerOn('')}
              // Only focus from the keyboard holds it: a click or swipe leaves focus on the button, which
              // would otherwise hold it up for good.
              onFocus={(event) => {
                if (focusVisible(event.currentTarget)) setFocusOn(key);
              }}
              onBlur={() => setFocusOn('')}
              onPointerDown={() => {
                swiped.current = false;
              }}
              onKeyDown={(event) => {
                swiped.current = false;
                if (event.key !== 'Escape' || liveKey.current !== key) return;
                // The pack's own Escape (leave the pack) is for when no toast has the focus.
                event.preventDefault();
                setAway(STAY);
                onDismiss(shown.map((a) => a.id));
              }}
              onClick={() => {
                if (liveKey.current !== key) return;
                if (swiped.current) {
                  swiped.current = false;
                  return;
                }
                setAway(STAY);
                onDismiss(shown.map((a) => a.id));
                onOpen(shown[0].opens ?? 'achievements');
              }}
              // Follows the finger and springs back unless it is thrown far or fast enough to leave.
              drag
              dragSnapToOrigin
              dragMomentum={false}
              onDrag={(_, info) => {
                if (Math.hypot(info.offset.x, info.offset.y) > TAP_SLOP) swiped.current = true;
              }}
              onDragEnd={(_, info) => {
                if (liveKey.current === key) swipe(info);
                // A drag that ends where it began is a tap, and no click may follow a swipe that did not.
                if (Math.hypot(info.offset.x, info.offset.y) <= TAP_SLOP) swiped.current = false;
              }}
              custom={away}
              variants={reduced ? TOAST_FADE : TOAST_MOTION}
              initial="enter"
              animate="shown"
              exit="leave"
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
