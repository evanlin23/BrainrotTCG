import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { REPO } from '../../constants/config';
import { browserDiagnostics, recordDiagnostic } from '../../game/diagnostics';
import '../../styles/AppErrorBoundary.css';

const reloadPage = () => window.location.reload();

/** The same allowlist-only details as the Report a problem sheet: never the error, save, name or key. */
function sanitizedReport() {
  try {
    return JSON.stringify(browserDiagnostics(), null, 2);
  } catch {
    return '{ "format": 1 }';
  }
}

/** Diagnostics are best-effort: a fault there must never take the fallback down too. */
function noteDiagnostic(event: Parameters<typeof recordDiagnostic>[0]) {
  try {
    recordDiagnostic(event);
  } catch {
    // Ignore: the report just lacks this category.
  }
}

/**
 * Deliberately self-contained (no Sheet, motion or game state) so a fault in shared UI can't take
 * the fallback down with it. It never reads, writes, clears, imports or exports player data.
 */
function CrashFallback({ report, reload }: { report: string; reload: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [note, setNote] = useState('');
  useEffect(() => heading.current?.focus(), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setNote('Copied the report. Nothing was uploaded.');
    } catch {
      noteDiagnostic('copy-failed');
      setNote('Copy was blocked. Select the report text and copy it manually. Nothing was uploaded.');
    }
  };
  return (
    <main className="app-crash" aria-labelledby="app-crash-title">
      <h1 id="app-crash-title" ref={heading} tabIndex={-1}>Something went wrong</h1>
      <p>The game hit an unexpected problem and stopped showing this screen. Reloading the page usually fixes it.</p>
      <p>This screen does not change, clear or upload anything.</p>
      <button className="btn btn--primary" type="button" onClick={reload}>Reload</button>
      <details className="app-crash-report">
        <summary>Show bug report</summary>
        <p>These details exclude player keys, saves, names, proof links and error messages. Nothing is sent automatically.</p>
        <label htmlFor="app-crash-report-text">Report details</label>
        <textarea id="app-crash-report-text" readOnly value={report} spellCheck={false} />
        <p role="status">{note}</p>
        <div className="app-crash-actions">
          <button className="btn btn--secondary btn--sm" type="button" onClick={() => void copy()}>Copy report</button>
          <a className="btn btn--secondary btn--sm" href={`https://github.com/${REPO}/issues/new?template=bug.yml`} target="_blank" rel="noopener noreferrer">Open GitHub issues</a>
        </div>
        <p>Posting requires a GitHub account. Paste only the details you want to make public and describe what you were trying to do.</p>
      </details>
    </main>
  );
}

interface Props {
  children: ReactNode;
  /** Only called when the player presses Reload. Injected by tests. */
  reload?: () => void;
}

/**
 * Catches render errors anywhere under the app. The error itself is dropped: only the allowlisted
 * 'render-error' category is noted, and only if the player opted in to diagnostics.
 * Failures while the app boots, before React mounts (see main.tsx), are outside this boundary.
 */
export default class AppErrorBoundary extends Component<Props, { crashed: boolean; report: string }> {
  state = { crashed: false, report: '' };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch() {
    noteDiagnostic('render-error');
    // Build the report only after noting the category, so the textarea and Copy both include it.
    this.setState({ report: sanitizedReport() });
  }

  render() {
    return this.state.crashed ? <CrashFallback report={this.state.report} reload={this.props.reload ?? reloadPage} /> : this.props.children;
  }
}
