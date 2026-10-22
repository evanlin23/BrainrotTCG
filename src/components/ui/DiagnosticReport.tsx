import { useId, useState } from 'react';
import { REPO } from '../../constants/config';
import { browserDiagnostics, clearDiagnostics, hasRecordedSteps, isDiagnosticCaptureEnabled, recordDiagnostic, restateCapture, setBrowserDiagnosticCapture } from '../../game/diagnostics';
import Sheet from './Sheet';
import '../../styles/DiagnosticReport.css';

const preview = () => JSON.stringify(browserDiagnostics(), null, 2);
interface Props { onClose: () => void; }

/** Nothing is uploaded. The player can remove details before explicitly copying or posting. */
export default function DiagnosticReport({ onClose }: Props) {
  const id = useId();
  const textId = `${id}-text`;
  const guessId = `${id}-guess`;
  const staleId = `${id}-stale`;
  const captureOffId = `${id}-capture-off`;
  const [enabled, setEnabled] = useState(isDiagnosticCaptureEnabled);
  // `generated` is the last text this component produced, so a different draft holds the player's edits.
  const [generated, setGenerated] = useState(preview);
  const [draft, setDraft] = useState(generated);
  const [note, setNote] = useState('Review these details before sharing. You can edit or remove any of them.');
  const [copying, setCopying] = useState(false);
  // Open from the start when capture is already on, so a recording in progress is never hidden.
  const [recordOpen, setRecordOpen] = useState(isDiagnosticCaptureEnabled);
  const regenerate = () => {
    const next = preview();
    setGenerated(next);
    setDraft(next);
  };
  // Opting out must remove recorded steps from whatever will be copied, edited or not.
  const stale = !enabled && hasRecordedSteps(draft);
  const copy = async () => {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(draft);
      setNote('Copied the report. Nothing was uploaded.');
    } catch {
      recordDiagnostic('copy-failed');
      setNote('Copy was blocked. Select the report text and copy it manually. Nothing was uploaded.');
    } finally { setCopying(false); }
  };
  return (
    <Sheet title="Report a problem" onClose={onClose} size="sm" className="diagnostic-report">
      <p>No automatic uploads. These details exclude player keys, saves, names, proof links and raw error messages. Never attach a private save to a public issue.</p>
      <label htmlFor={textId}>Report details (editable)</label>
      <p id={guessId}>Browser and device are rough guesses from this browser's user agent, so correct them if they are wrong.</p>
      {!enabled && <p id={captureOffId}>Event capture is off, so this report has no recent events. You can turn it on under Record steps to reproduce.</p>}
      {stale && <p id={staleId}>This text still has recorded steps from before capture was turned off. Remove them or use Refresh details before copying.</p>}
      <textarea id={textId} aria-describedby={`${guessId}${enabled ? '' : ` ${captureOffId}`}${stale ? ` ${staleId}` : ''}`} value={draft} maxLength={8192} onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
      <div className="diagnostic-actions">
        <button className="btn btn--primary" type="button" disabled={copying || stale || !draft.trim()} onClick={() => void copy()}>Copy report</button>
        <button className="btn btn--secondary" type="button" onClick={regenerate}>Refresh details</button>
      </div>
      <p role="status">{note}</p>
      <details className="diagnostic-record" open={recordOpen} onToggle={(event) => setRecordOpen(event.currentTarget.open)}>
        <summary>Record steps to reproduce{enabled ? ' (on)' : ''}</summary>
        <label className="diagnostic-capture">
          <input type="checkbox" checked={enabled} onChange={(event) => {
            const next = event.target.checked;
            setBrowserDiagnosticCapture(next);
            setEnabled(next);
            if (draft === generated) return regenerate();
            // Edited text stays; only the capture fields are re-stated.
            const restated = restateCapture(draft);
            if (restated === undefined) {
              setNote('Your edited text was kept, but it is no longer valid report JSON, so capture details in it were not updated. Refresh details replaces it with a new report.');
            } else {
              setDraft(restated);
              setNote(next ? 'Your edits were kept. Capture is on, so new steps appear after you refresh details.' : 'Your edits were kept. Capture is off and recorded steps were removed from the report.');
            }
          }} />
          Record navigation and browser-error categories in this tab until reload
        </label>
        <p>Capture is optional and starts off. If enabled, reproduce the problem, return here, then use Refresh details above. No error text or visited links are recorded.</p>
        <div className="diagnostic-actions">
          <button className="btn btn--secondary btn--sm" type="button" onClick={() => {
            clearDiagnostics();
            regenerate();
            setNote('Recorded steps cleared from this tab.');
          }}>Clear recorded steps</button>
        </div>
      </details>
      <p>Posting requires a GitHub account, and GitHub requires users to be 13 or older. Paste only the details you want to make public and describe what you were trying to do.</p>
      <div className="diagnostic-actions">
        <a className="btn btn--secondary" href={`https://github.com/${REPO}/issues/new?template=bug.yml`} target="_blank" rel="noopener noreferrer">Open GitHub issues</a>
      </div>
    </Sheet>
  );
}
