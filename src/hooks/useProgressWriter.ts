import { useEffect, useRef, useState } from 'react';
import { createProgressWriter, type HeldProgress, type ProgressWriter, type ProgressWriterHost } from '../game/progressWriter';

/**
 * Stores the tab's progress after React commits it (see game/progressWriter.ts), never during a React
 * updater, which can be replayed. The first render's progress is what the tab loaded, so nothing is
 * written for it. The host is read once: pass one object (memoized) whose functions stay the same for
 * the tab's life. Outside production builds, a host that changes after the first render logs one
 * console error, since the writer keeps calling the first host's functions.
 */
export function useProgressWriter(progress: HeldProgress, host: ProgressWriterHost): ProgressWriter {
  const [writer] = useState(() => createProgressWriter(host));
  const firstHost = useRef(host);
  const warned = useRef(false);
  useEffect(() => {
    if (!import.meta.env.DEV || warned.current || host === firstHost.current) return;
    warned.current = true;
    console.error('useProgressWriter: the host changed after the first render, but the writer keeps calling the first one. '
      + 'Pass a host that stays the same for the tab\'s life (useMemo).');
  }, [host]);
  const { collection, achievements, stats, hallOfFame, settings } = progress;
  useEffect(() => {
    writer.commit({ collection, achievements, stats, hallOfFame, settings });
  }, [writer, collection, achievements, stats, hallOfFame, settings]);
  return writer;
}
