import { useEffect, useId, useRef, useState } from 'react';
import { discardCollectionRecovery, downloadCollectionRecovery } from '../../game/collectionRecovery';

interface KeptAsideActionsProps {
  /** 'banner': link buttons inside the save warning. 'settings': row buttons in Save & backup. */
  variant: 'banner' | 'settings';
  /** Nothing is kept aside any more (discarded here, or gone before Download). The parent moves focus. */
  onGone: () => void;
}

/**
 * Download or discard the unreadable collection data kept aside (game/collectionRecovery). Discard asks
 * first, in place, like Restore's Keep mine / Replace: the safe answer takes focus and reads the question.
 */
const KeptAsideActions = ({ variant, onGone }: KeptAsideActionsProps) => {
  const [confirming, setConfirming] = useState(false);
  const [refused, setRefused] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const backToDiscard = useRef(false);
  const noteId = useId();
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (backToDiscard.current) discardRef.current?.focus();
    backToDiscard.current = false;
  }, [confirming, refused]);

  const plain = variant === 'banner' ? 'link-btn save-warning-action' : 'btn btn--secondary btn--sm';
  const strong = variant === 'banner' ? 'link-btn save-warning-action' : 'btn btn--primary btn--sm';
  const note = variant === 'banner' ? undefined : 'settings-desc';
  const answer = (discard: boolean) => {
    backToDiscard.current = true;
    setConfirming(false);
    if (!discard) return;
    const gone = discardCollectionRecovery();
    setRefused(!gone);
    if (gone) onGone();
  };

  return (
    <span className={variant === 'settings' ? 'settings-actions' : undefined}>
      {confirming ? (
        <>
          <span id={noteId} className={note}>{variant === 'banner' && ' '}Discard it for good? Only a downloaded copy keeps it.</span>
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
          <button type="button" className={plain} onClick={() => { if (!downloadCollectionRecovery()) onGone(); }}>
            Download
          </button>
          <button type="button" ref={discardRef} className={plain} aria-describedby={refused ? noteId : undefined} onClick={() => setConfirming(true)}>
            Discard
          </button>
        </>
      )}
    </span>
  );
};

export default KeptAsideActions;
