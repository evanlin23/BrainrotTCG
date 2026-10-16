import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { collectionRecoveryPrint, discardCollectionRecovery, downloadCollectionRecovery } from '../../game/collectionRecovery';

interface KeptAsideActionsProps {
  /** 'banner': link buttons inside the save warning. 'settings': row buttons in Save & backup. */
  variant: 'banner' | 'settings';
  /**
   * Whether this tab may still act on the kept-aside data: false once another tab imported or switched
   * player (the archive may now hold that player's data) or stored newer progress. Checked on every click,
   * including the confirm, before anything is downloaded or discarded.
   */
  canAct: () => boolean;
  /** Nothing is kept aside any more (discarded here, or gone before Download). The parent moves focus. */
  onGone: () => void;
  /** What's kept aside changed since Discard asked (another tab kept more aside): the parent refreshes its note. */
  onChanged: () => void;
  /**
   * These controls left while focus was in them (the tab went stale, or the player changed), so focus
   * fell to the page body. The parent moves it: to Reload if that's shown, else to the section heading.
   */
  onLeave: () => void;
}

/** The question on screen, and the fingerprint of what was kept aside when it was asked. */
interface Asked {
  print: string | null;
  changed: boolean;
}

/**
 * Download or discard the unreadable collection data kept aside (game/collectionRecovery). Discard asks
 * first, in place, like Restore's Keep mine / Replace: the safe answer takes focus and reads the question.
 * If what's kept aside changed after the question, it asks again instead of discarding the new data.
 */
const KeptAsideActions = ({ variant, canAct, onGone, onChanged, onLeave }: KeptAsideActionsProps) => {
  const [asked, setAsked] = useState<Asked | null>(null);
  const [refused, setRefused] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const backToDiscard = useRef(false);
  const noteId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  // React runs this cleanup before it removes the buttons, while focus is still on one. Whatever should
  // take focus (Reload, say) may only be added later in the same commit, so the parent acts after it.
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      if (!root?.contains(document.activeElement)) return;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (!root.isConnected && (!active || active === document.body)) onLeave();
      });
    };
  }, [onLeave]);
  useEffect(() => {
    if (asked) keepRef.current?.focus();
    else if (backToDiscard.current) discardRef.current?.focus();
    backToDiscard.current = false;
  }, [asked, refused]);

  const plain = variant === 'banner' ? 'link-btn save-warning-action' : 'btn btn--secondary btn--sm';
  const strong = variant === 'banner' ? 'link-btn save-warning-action' : 'btn btn--primary btn--sm';
  const note = variant === 'banner' ? undefined : 'settings-desc';
  const ask = () => {
    if (canAct()) setAsked({ print: collectionRecoveryPrint(), changed: false });
  };
  const answer = (discard: boolean) => {
    backToDiscard.current = true;
    if (!discard || !asked || !canAct()) {
      setAsked(null);
      return;
    }
    const result = discardCollectionRecovery(asked.print);
    if (result === 'changed') {
      backToDiscard.current = false;
      setAsked({ print: collectionRecoveryPrint(), changed: true });
      onChanged();
      return;
    }
    setAsked(null);
    setRefused(result === 'refused');
    if (result === 'discarded') onGone();
  };

  return (
    <span ref={rootRef} className={variant === 'settings' ? 'settings-actions' : undefined}>
      {asked ? (
        <>
          <span id={noteId} className={note}>
            {variant === 'banner' && ' '}
            {asked.changed
              ? 'The kept-aside data changed since you asked. Discard it all for good? Only a downloaded copy keeps it.'
              : 'Discard it for good? Only a downloaded copy keeps it.'}
          </span>
          <button type="button" ref={keepRef} className={plain} aria-describedby={noteId} onClick={() => answer(false)}>
            Keep it
          </button>
          <button type="button" className={strong} onClick={() => answer(true)}>
            Discard for good
          </button>
        </>
      ) : (
        <>
          {refused && <span id={noteId} className={note}>{variant === 'banner' && ' '}This browser wouldn&apos;t discard it.</span>}
          <button type="button" className={plain} onClick={() => { if (canAct() && !downloadCollectionRecovery()) onGone(); }}>
            Download
          </button>
          <button type="button" ref={discardRef} className={plain} aria-describedby={refused ? noteId : undefined} onClick={ask}>
            Discard
          </button>
        </>
      )}
    </span>
  );
};

export default KeptAsideActions;
