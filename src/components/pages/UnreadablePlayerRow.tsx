import { useEffect, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { downloadSaveFile } from '../../game/saveFile';

/** The row's note before anything is chosen: the reason, and the three ways on. */
export const UNREADABLE_PLAYER_NOTE = "This browser's player record is damaged and can't be read, so packs are paused. Nothing was lost."
  + ' Restore a backup, download the save with the damaged record, or start a new player.';

/** Asked before a new player is started: what is cleared, what is kept and where, and what to do first. */
export const START_NEW_PLAYER_QUESTION = 'Start a new player? You start over with a new key, and your collection, stats, pack history,'
  + " best cards, achievements and Hall of Fame entries are cleared. A copy stays in this browser's storage for recovery by hand,"
  + " but the app can't restore it. Download first to keep a file of the damaged record and your progress. Your settings stay.";

/** The button that downloads the whole save with the damaged record in it (saveFile's downloadSaveFile). */
export const DOWNLOAD_DAMAGED_LABEL = 'Download save with damaged record';

interface UnreadablePlayerRowProps {
    /** Opens the file picker of Restore (the save file's Import). */
    onRestore: () => void;
    /** Returns an error to show, or null (the page then reloads with the new player). */
    onStartNewPlayer: () => string | null;
}

/**
 * Settings > Save & backup, first, while this browser's player record can't be read (#1052): restore a
 * backup, download the save with the damaged record's bytes as they are (a file named as a copy for
 * recovery, never as a backup), or start a new player, asked in place.
 */
const UnreadablePlayerRow = ({ onRestore, onStartNewPlayer }: UnreadablePlayerRowProps) => {
    const [note, setNote] = useState(UNREADABLE_PLAYER_NOTE);
    const [asking, setAsking] = useState(false);
    const keepRef = useRef<HTMLButtonElement>(null);
    const startRef = useRef<HTMLButtonElement>(null);
    /** Set when an answer removes the question's buttons: Start a new player takes the focus they held. */
    const refocusStart = useRef(false);
    useEffect(() => {
        if (asking) keepRef.current?.focus();
    }, [asking]);
    useEffect(() => {
        if (!refocusStart.current) return;
        refocusStart.current = false;
        startRef.current?.focus();
    });
    const handleDownload = () => {
        try {
            setNote(downloadSaveFile());
        } catch {
            setNote("Couldn't read browser storage to download the save with the damaged record.");
        }
    };
    const answer = (start: boolean) => {
        refocusStart.current = true;
        setAsking(false);
        if (!start) return setNote(UNREADABLE_PLAYER_NOTE);
        const error = onStartNewPlayer();
        if (error) setNote(error);
    };
    return (
        <div className="settings-row settings-row--reflow">
            <span className="settings-text">
                <span className="settings-label">Player record</span>
                <span className="settings-desc" role="status">{asking ? START_NEW_PLAYER_QUESTION : note}</span>
            </span>
            {asking ? (
                <span className="settings-actions settings-actions--ask">
                    <button type="button" ref={keepRef} className="btn btn--primary btn--sm" onClick={() => answer(false)}>
                        Keep my record
                    </button>
                    <button type="button" className="btn btn--danger btn--sm" onClick={() => answer(true)}>
                        Start a new player
                    </button>
                </span>
            ) : (
                <span className="settings-actions settings-actions--ask">
                    <button type="button" className="btn btn--secondary btn--sm" onClick={onRestore}>
                        <Upload aria-hidden="true" /> Restore a backup
                    </button>
                    <button type="button" className="btn btn--secondary btn--sm" onClick={handleDownload}>
                        <Download aria-hidden="true" /> {DOWNLOAD_DAMAGED_LABEL}
                    </button>
                    <button type="button" ref={startRef} className="btn btn--secondary btn--sm" onClick={() => setAsking(true)}>
                        Start a new player
                    </button>
                </span>
            )}
        </div>
    );
};

export default UnreadablePlayerRow;
