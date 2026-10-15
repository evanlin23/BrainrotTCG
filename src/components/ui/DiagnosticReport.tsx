import { useState } from 'react';
import { REPO } from '../../constants/config';
import { browserDiagnostics, clearDiagnostics, isDiagnosticCaptureEnabled, recordDiagnostic, setBrowserDiagnosticCapture } from '../../game/diagnostics';
import Sheet from './Sheet';
import '../../styles/DiagnosticReport.css';

const preview = () => JSON.stringify(browserDiagnostics(), null, 2);
interface Props { onClose: () => void; }

/** Nothing is uploaded. The player can remove details before explicitly copying or posting. */
export default function DiagnosticReport({ onClose }: Props) {
  const [enabled, setEnabled] = useState(isDiagnosticCaptureEnabled);
  const [draft, setDraft] = useState(preview);
  const [note, setNote] = useState('Review these details before sharing. You can edit or remove any of them.');
  const [copying, setCopying] = useState(false);
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
      <label className="diagnostic-capture">
        <input type="checkbox" checked={enabled} onChange={(event) => {
          const next = event.target.checked;
          setBrowserDiagnosticCapture(next);
          setEnabled(next);
          setDraft(preview());
        }} />
        Record navigation and browser-error categories in this tab until reload
      </label>
      <p>Capture is optional and starts off. If enabled, reproduce the problem, return here, then refresh the details. No error text or visited links are recorded.</p>
      <div className="diagnostic-actions">
        <button className="btn btn--secondary btn--sm" type="button" onClick={() => setDraft(preview())}>Refresh details</button>
        <button className="btn btn--secondary btn--sm" type="button" onClick={() => {
          clearDiagnostics();
          setDraft(preview());
          setNote('Recorded steps cleared from this tab.');
        }}>Clear recorded steps</button>
      </div>
      <label htmlFor="diagnostic-report-text">Report details (editable)</label>
      {!enabled && <p id="diagnostic-capture-off">Event capture is off, so this report has no recent events.</p>}
      <textarea id="diagnostic-report-text" aria-describedby={enabled ? undefined : 'diagnostic-capture-off'} value={draft} maxLength={8192} onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
      <p role="status">{note}</p>
      <div className="diagnostic-actions">
        <button className="btn btn--primary" type="button" disabled={copying || !draft.trim()} onClick={() => void copy()}>Copy report</button>
        <a className="btn btn--secondary" href={`https://github.com/${REPO}/issues/new?template=bug.yml`} target="_blank" rel="noopener noreferrer">Open GitHub issues</a>
      </div>
      <p>Posting requires a GitHub account. Paste only the details you want to make public and describe what you were trying to do.</p>
    </Sheet>
  );
}
