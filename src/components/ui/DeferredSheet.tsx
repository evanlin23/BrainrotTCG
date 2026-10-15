import { createElement, useEffect, useState, type ComponentType, type MouseEvent } from 'react';
import Sheet, { type SheetSize } from './Sheet';
import { reloadPage } from '../../game/reload';

interface Props<P extends { onClose: () => void }> {
  load: () => Promise<{ default: ComponentType<P> }>;
  title: string;
  screenProps: P;
  /** The loaded screen's Sheet size, so the placeholder doesn't jump when it arrives. */
  size?: SheetSize;
}

/**
 * Only mounted when requested. Import failures are retryable; closing retires late results. A deploy
 * replaces the old chunks, so a tab opened before it can't load them: offer a reload, which keeps
 * the saves (they live in storage).
 */
const DeferredSheet = <P extends { onClose: () => void }>({ load, title, screenProps, size = 'md' }: Props<P>) => {
  const [state, setState] = useState<{ component: ComponentType<P> } | { error: true } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    load().then(
      (module) => { if (active) setState({ component: module.default }); },
      () => { if (active) setState({ error: true }); },
    );
    return () => { active = false; };
  }, [load, attempt]);

  if (state && 'component' in state) return createElement(state.component, screenProps);
  const retry = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
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
