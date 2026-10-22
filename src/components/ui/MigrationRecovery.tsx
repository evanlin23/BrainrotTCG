import { useEffect, useRef, useState } from 'react';
import { recordDiagnostic } from '../../game/diagnostics';
import { legacySaveFile } from '../../utils/migrations';
import '../../styles/AppErrorBoundary.css';

const reloadPage = () => window.location.reload();

/** Save the stored save keys, as stored, to a local file. Nothing leaves this browser and storage is untouched. */
const downloadLegacySave = () => {
  const file = legacySaveFile();
  const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/**
 * Shown instead of the game when saved data exists but upgrading it couldn't be written (main.tsx),
 * usually because this browser's storage is full. Same plain layout as CrashFallback. It only reads
 * storage, to offer the save as a file.
 */
export default function MigrationRecovery({ reload = reloadPage, download = downloadLegacySave }: {
  reload?: () => void;
  download?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    heading.current?.focus();
    try {
      recordDiagnostic('unhandled-error');
    } catch {
      // Diagnostics are best-effort.
    }
  }, []);
  const save = () => {
    try {
      download();
      setNote('Saved a copy of your save data as a file. Nothing was uploaded or changed.');
    } catch {
      setNote("Couldn't make the file. Your save data is still in this browser, unchanged.");
    }
  };
  return (
    <main className="app-crash" aria-labelledby="migration-recovery-title">
      <h1 id="migration-recovery-title" ref={heading} tabIndex={-1}>Your save needs room to update</h1>
      <p>This version of the game has to update your saved cards before it starts, but this browser refused to store the update, usually because its storage for this site is full. Reloading alone won't fix it.</p>
      <p>Your save is still in this browser. Download a copy to keep it safe, then free up space (for example by clearing data other sites stored in this browser) and reload.</p>
      <div className="app-crash-actions">
        <button className="btn btn--primary" type="button" onClick={save}>Download save data</button>
        <button className="btn btn--secondary" type="button" onClick={reload}>Reload</button>
      </div>
      <p role="status">{note}</p>
    </main>
  );
}
