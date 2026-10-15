import { createElement, useEffect, useState, type ComponentType } from 'react';
import Sheet from './Sheet';

interface Props<P extends { onClose: () => void }> {
  load: () => Promise<{ default: ComponentType<P> }>;
  title: string;
  screenProps: P;
}

/** Only mounted when requested. Import failures are retryable; closing retires late results. */
const DeferredSheet = <P extends { onClose: () => void }>({ load, title, screenProps }: Props<P>) => {
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
  return (
    <Sheet title={title} onClose={screenProps.onClose} size="sm">
      {state ? (
        <>
          <p role="alert">Couldn't load {title}. Check your connection and try again.</p>
          <button type="button" className="btn btn--primary" onClick={(event) => {
            event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
            setState(null);
            setAttempt((n) => n + 1);
          }}>Retry</button>
        </>
      ) : <p role="status">Loading {title}…</p>}
    </Sheet>
  );
};

export default DeferredSheet;
