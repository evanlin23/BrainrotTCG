import { useEffect, useState } from 'react';
import { COUNT_UP_MS, countUpValue } from '../game/packTakeover';

/**
 * - `off`: no count-up; the figure is its final value from the first render.
 * - `wait`: the count-up is still to come (a takeover is on); the figure reads 0.
 * - `run`: counting; reduced motion lands on the final value at once.
 */
export type CountUpMode = 'off' | 'wait' | 'run';

/**
 * A figure that counts up to `target`: the value to show, and whether it is still short of `target`
 * (so the caller can keep the final value readable while the digits climb).
 */
export const useCountUp = (target: number, mode: CountUpMode, reduced: boolean): { value: number; counting: boolean } => {
  const [elapsed, setElapsed] = useState(0);
  const running = mode === 'run' && !reduced;
  useEffect(() => {
    if (!running) return;
    const started = performance.now();
    let frame = 0;
    const tick = () => {
      const passed = performance.now() - started;
      setElapsed(passed);
      if (passed < COUNT_UP_MS) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);
  const value = mode === 'off' ? target : mode === 'wait' ? 0 : reduced ? target : countUpValue(target, elapsed);
  return { value, counting: value !== target };
};
