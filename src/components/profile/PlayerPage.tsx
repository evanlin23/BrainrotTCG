import { useRef, useState } from 'react';
import { MAX_NAME_LENGTH } from '../../engine';
import { getPlayer, renamePlayer, type RenameResult } from '../../game/player';
import type { Settings } from '../../types';
import Sheet from '../ui/Sheet';
import RewardsPanel from './RewardsPanel';
import { packImageUrl } from '../../content/art';
import { DEFAULT_SET_ID } from '../../content/sets';
import '../../styles/Settings.css';
import '../../styles/Pulls.css';

const SAVE_FAILED = "Couldn't save your name in this browser. Try again.";

interface PlayerPageProps {
  level: number;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  onClose: () => void;
  onOpenGoals: () => void;
  onOpenSave: () => void;
}

/** Local player identity and utilities; this is not an online sign-in session. */
export default function PlayerPage({ level, settings, onSettingsChange, onClose, onOpenGoals, onOpenSave }: PlayerPageProps) {
  const [player, setPlayer] = useState(getPlayer);
  const [nameDraft, setNameDraft] = useState(player.name);
  const [nameStatus, setNameStatus] = useState('');
  /** Counts failed saves; a repeat of the same failure remounts the status text so it is announced again. */
  const [failures, setFailures] = useState(0);
  /** Set once a close was refused because the save failed; editing the name clears it. */
  const closeRefused = useRef(false);
  /** The draft whose last save failed; leaving reuses that result instead of writing it again. */
  const failedDraft = useRef<string | null>(null);
  /** Counts saves; a pointer press on Save name compares it with its pointerdown to see if its own blur saved. */
  const saves = useRef(0);
  const savesAtPress = useRef<number | null>(null);
  /**
   * Store the draft if it is a valid, changed name. Only a stored name is reported as saved; a
   * refused write keeps the draft so the player can retry. Leaving the field (`fromBlur`) saves too,
   * but a blank draft is left alone there so the player can keep typing.
   */
  const saveName = (fromBlur = false): RenameResult['status'] => {
    saves.current += 1;
    const result = renamePlayer(nameDraft);
    setPlayer(result.player);
    failedDraft.current = result.status === 'failed' ? nameDraft : null;
    switch (result.status) {
      case 'saved':
        setNameDraft(result.player.name);
        setNameStatus('Display name saved.');
        break;
      case 'failed':
        setNameStatus(SAVE_FAILED);
        setFailures((count) => count + 1);
        break;
      case 'blank':
        if (fromBlur) break;
        setNameDraft(result.player.name);
        setNameStatus("A name can't be blank, so your current name stays.");
        break;
      case 'unchanged':
        // Nothing was written, so whatever the status line says stays true.
        setNameDraft(result.player.name);
    }
    return result.status;
  };
  /**
   * Escape, the backdrop, Close and the Goals and Save links keep the draft the same way leaving the
   * field does: save it. If that save fails, stay once so the player sees the error with their draft
   * still there. A pointer press blurs the field first, and that blur already saved (and announced)
   * the draft, so a draft that just failed is not written or announced a second time.
   */
  const leave = (next: () => void) => {
    const status = failedDraft.current === nameDraft ? 'failed' : saveName(true);
    if (status === 'failed' && !closeRefused.current) {
      closeRefused.current = true;
      return;
    }
    next();
  };
  const close = () => leave(onClose);
  return <Sheet title="Player" onClose={close} size="sm">
    <p className="share-note">Your player is saved in this browser. Back up your save to keep your player key.</p>
    <section className="settings-group">
      <h3 className="section-title">Display name</h3>
      <label className="settings-field">
        <span className="settings-label">Name shown on shared pulls</span>
        <input className="settings-input" value={nameDraft} autoComplete="nickname" spellCheck={false}
          onChange={(event) => {
            setNameDraft(Array.from(event.target.value).slice(0, MAX_NAME_LENGTH).join(''));
            setNameStatus('');
            closeRefused.current = false;
            failedDraft.current = null;
          }}
          onBlur={() => saveName(true)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveName(); } }} />
      </label>
      <button type="button" className="btn btn--secondary"
        onPointerDown={() => { savesAtPress.current = saves.current; }}
        onClick={(event) => {
          // A pointer press blurs the field first. If that blur's save just failed with this draft, it
          // was already written and announced, so this press doesn't repeat it; a later press retries.
          const blurSaved = event.detail > 0 && savesAtPress.current !== null && savesAtPress.current !== saves.current;
          savesAtPress.current = null;
          if (blurSaved && failedDraft.current === nameDraft) return;
          saveName();
        }}>Save name</button>
      <p>Player ID #{player.fingerprint}</p>
      {/* Only save results go in the live region, so opening or editing announces nothing. */}
      <p role="status"><span key={failures}>{nameStatus}</span></p>
    </section>
    <div className="personal-nav">
      <button type="button" className="btn btn--secondary" onClick={() => leave(onOpenGoals)}>Goals & rewards</button>
      <button type="button" className="btn btn--secondary" onClick={() => leave(onOpenSave)}>Save & restore</button>
    </div>
    <RewardsPanel level={level} settings={settings} onSettingsChange={onSettingsChange} packImage={packImageUrl(DEFAULT_SET_ID)} />
  </Sheet>;
}
