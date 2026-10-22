import { createElement, useEffect, useId, useRef, useState, type ComponentType } from 'react';
import { X } from 'lucide-react';
import { purgeBrokenStylesheets, type SheetLoad } from './sheetEntry';
import { reloadPage } from '../../game/reload';
import '../../styles/Page.css';

/** A part of a page to bring into view once it has loaded. `n` changes with every request, so asking again scrolls again. */
export type PageSection = { id: string; n: number } | null;

interface Props<P> {
  /** A `sheetLoader`: a page whose chunk has already arrived shows straight away, with no skeleton. */
  load: SheetLoad<P>;
  title: string;
  screenProps: P;
  onClose: () => void;
  /** The placeholder's shape while the chunk loads: a list of rows (Rankings) or a few blocks. */
  skeleton?: 'rows' | 'blocks';
  width?: 'md' | 'lg';
  section?: PageSection;
  /** Move focus to the heading on mount: the page was opened from inside the app, not loaded directly. */
  autoFocus?: boolean;
}

type State<P> = { component: ComponentType<P> } | { error: true } | null;

/**
 * A full page in place of the packs screen (#/cards, #/rankings, #/profile, #/settings). Its screen is
 * loaded on demand: a skeleton holds its place meanwhile, and a failed load offers Reload (a deploy
 * replaced the old chunks) and Retry, like DeferredSheet.
 */
const Page = <P extends object>({ load, title, screenProps, onClose, skeleton = 'blocks', width = 'lg', section = null, autoFocus = false }: Props<P>) => {
  const [state, setState] = useState<State<P>>(() => (load.loaded ? { component: load.loaded } : null));
  const [attempt, setAttempt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const ready = state !== null && 'component' in state;

  useEffect(() => {
    if (autoFocus) headingRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    if (ready) return;
    let active = true;
    load().then(
      (module) => { if (active) setState({ component: module.default }); },
      () => { if (active) setState({ error: true }); },
    );
    return () => { active = false; };
  }, [load, attempt, ready]);

  useEffect(() => {
    if (!ready || !section) return;
    const target = document.getElementById(section.id);
    if (!target) return;
    target.querySelector<HTMLElement>('h2, h3')?.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'start' });
  }, [ready, section]);

  const retry = () => {
    headingRef.current?.focus({ preventScroll: true });
    purgeBrokenStylesheets();
    setState(null);
    setAttempt((n) => n + 1);
  };

  return (
    <main className={`page page--${width}`} aria-labelledby={titleId}>
      <div className="page-inner">
        <header className="page-header">
          <h1 id={titleId} ref={headingRef} className="page-title" tabIndex={-1}>{title}</h1>
          <button type="button" className="icon-btn page-close" onClick={onClose} aria-label={`Close ${title}`}>
            <X strokeWidth={2.4} />
          </button>
        </header>
        {ready ? createElement(state.component, screenProps) : state ? (
          <div className="page-error">
            <p role="alert">
              Couldn't load {title}. The game was probably updated since you opened it: reload to get the new
              version (your collection stays saved), or check your connection and retry.
            </p>
            <div className="page-error-actions">
              <button type="button" className="btn btn--primary" onClick={() => reloadPage()}>Reload</button>
              <button type="button" className="btn btn--secondary" onClick={retry}>Retry</button>
            </div>
          </div>
        ) : (
          <div className={`page-skeleton page-skeleton--${skeleton}`} role="status">
            <span className="sr-only">Loading {title}…</span>
            {Array.from({ length: skeleton === 'rows' ? 8 : 3 }, (_, n) => <div key={n} className="page-skeleton-item" aria-hidden="true" />)}
          </div>
        )}
      </div>
    </main>
  );
};

export default Page;
