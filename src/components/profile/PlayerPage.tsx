import { useState } from 'react';
import { MAX_NAME_LENGTH } from '../../engine';
import { getPlayer, renamePlayer } from '../../game/player';
import type { Settings } from '../../types';
import Sheet from '../ui/Sheet';
import RewardsPanel from './RewardsPanel';
import { packImageUrl } from '../../content/art';
import { DEFAULT_SET_ID } from '../../content/sets';
import '../../styles/Settings.css';
import '../../styles/Pulls.css';

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
  /**
   * Store the draft if it is a valid, changed name. Only a stored name is reported as saved; a
   * refused write keeps the draft so the player can retry. Leaving the field (`fromBlur`) saves too,
   * but a blank draft is left alone there so the player can keep typing.
   */
  const saveName = (fromBlur = false) => {
    const result = renamePlayer(nameDraft);
    setPlayer(result.player);
    switch (result.status) {
      case 'saved':
        setNameDraft(result.player.name);
        setNameStatus('Display name saved.');
        return;
      case 'failed':
        setNameStatus("Couldn't save your name in this browser. Try again.");
        return;
      case 'blank':
        if (fromBlur) return;
        setNameDraft(result.player.name);
        setNameStatus("A name can't be blank, so your current name stays.");
        return;
      case 'unchanged':
        // Nothing was written, so whatever the status line says stays true.
        setNameDraft(result.player.name);
    }
  };
  return <Sheet title="Player" onClose={onClose} size="sm">
    <p className="share-note">Your player is saved in this browser. Back up your save to keep your player key.</p>
    <section className="settings-group">
      <h3 className="section-title">Display name</h3>
      <label className="settings-field">
        <span className="settings-label">Name shown on shared pulls</span>
        <input className="settings-input" value={nameDraft} autoComplete="nickname" spellCheck={false}
          onChange={(event) => { setNameDraft(Array.from(event.target.value).slice(0, MAX_NAME_LENGTH).join('')); setNameStatus(''); }}
          onBlur={() => saveName(true)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveName(); } }} />
      </label>
      <button type="button" className="btn btn--secondary" onClick={() => saveName()}>Save name</button>
      <p role="status">{nameStatus || `Player ID #${player.fingerprint}`}</p>
    </section>
    <div className="personal-nav">
      <button type="button" className="btn btn--secondary" onClick={onOpenGoals}>Goals & rewards</button>
      <button type="button" className="btn btn--secondary" onClick={onOpenSave}>Save & restore</button>
    </div>
    <RewardsPanel level={level} settings={settings} onSettingsChange={onSettingsChange} packImage={packImageUrl(DEFAULT_SET_ID)} />
  </Sheet>;
}
