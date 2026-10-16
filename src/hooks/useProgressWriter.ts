import { useEffect, useState } from 'react';
import { createProgressWriter, type HeldProgress, type ProgressWriter, type ProgressWriterHost } from '../game/progressWriter';

/**
 * Stores the tab's progress after React commits it (see game/progressWriter.ts), never during a React
 * updater, which can be replayed. The first render's progress is what the tab loaded, so nothing is
 * written for it. The host is read once: its functions must stay the same for the tab's life.
 */
export function useProgressWriter(progress: HeldProgress, host: ProgressWriterHost): ProgressWriter {
  const [writer] = useState(() => createProgressWriter(host));
  const { collection, achievements, stats, hallOfFame, settings } = progress;
  useEffect(() => {
    writer.commit({ collection, achievements, stats, hallOfFame, settings });
  }, [writer, collection, achievements, stats, hallOfFame, settings]);
  return writer;
}
