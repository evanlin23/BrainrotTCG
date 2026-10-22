import { createElement, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import Sheet, { type SheetSize } from './Sheet';
import { purgeBrokenStylesheets, SheetSettledContext, type SheetLoad } from './sheetEntry';
import { reloadPage } from '../../game/reload';

interface Props<P extends { onClose: () => void }> {
  /** A `sheetLoader` lets a screen that has already arrived open straight away, with no placeholder. */
  load: SheetLoad<P>;
  title: string;
  screenProps: P;
  /** The loaded screen's Sheet size, so the placeholder doesn't jump when it arrives. */
  size?: SheetSize;
}

type State<P> = { component: ComponentType<P>; settled: boolean } | { error: true } | null;

/** How long the placeholder's entrance runs (the panel's; the backdrop's is shorter). 0 under reduced motion. */
const entranceMs = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-slow')) || 0;

/**
 * Only mounted when requested. Import failures are retryable; closing retires late results. A deploy
 * replaces the old chunks, so a tab opened before it can't load them: offer a reload, which keeps
 * the saves (they live in storage).
 *
 * The sheet enters once, however long the chunk takes: a screen that arrives before the placeholder
 * reaches the screen replaces it before the next frame and makes the entrance itself; otherwise it
 * waits for the placeholder's entrance to finish and takes its place without one (SheetSettledContext).
 */
const DeferredSheet = <P extends { onClose: () => void }>({ load, title, screenProps, size = 'md' }: Props<P>) => {
  const [state, setState] = useState<State<P>>(() => (load.loaded ? { component: load.loaded, settled: false } : null));
  const [attempt, setAttempt] = useState(0);
  /** When the placeholder first reached the screen, starting its entrance; null until then. */
  const shownAt = useRef<number | null>(null);
  const ready = state !== null && 'component' in state;
  const settled = ready && state.settled;

  useLayoutEffect(() => {
    if (ready || shownAt.current !== null) return;
    const frame = requestAnimationFrame(() => { shownAt.current = performance.now(); });
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  useEffect(() => {
    if (ready) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    load().then(
      (module) => {
        if (!active) return;
        const show = (inPlace: boolean) => setState({ component: module.default, settled: inPlace });
        const since = shownAt.current;
        if (since === null) {
          flushSync(() => show(false));
          return;
        }
        const wait = entranceMs() - (performance.now() - since);
        if (wait > 0) timer = setTimeout(() => show(true), wait);
        else show(true);
      },
      () => { if (active) setState({ error: true }); },
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [load, attempt, ready]);

  useEffect(() => {
    if (!settled) return;
    // Only the sheet that took the placeholder's place skips its entrance: sheets opened later play theirs.
    const frame = requestAnimationFrame(() => setState((current) => (current && 'component' in current ? { component: current.component, settled: false } : current)));
    return () => cancelAnimationFrame(frame);
  }, [settled]);

  if (ready) return <SheetSettledContext value={state.settled}>{createElement(state.component, screenProps)}</SheetSettledContext>;
  const retry = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
    purgeBrokenStylesheets();
    setState(null);
    setAttempt((n) => n + 1);
  };
  return (
    <Sheet title={title} onClose={screenProps.onClose} size={size} className="sheet--deferred" footer={state && (
      <>
        <button type="button" className="btn btn--primary" onClick={() => reloadPage()}>Reload</button>
        <button type="button" className="btn btn--secondary" onClick={retry}>Retry</button>
      </>
    )}>
      {state ? (
        <p role="alert">
          Couldn't load {title}. The game was probably updated since you opened it: reload to get the new
          version (your collection stays saved), or check your connection and retry.
        </p>
      ) : <p role="status">Loading {title}…</p>}
    </Sheet>
  );
};

export default DeferredSheet;
