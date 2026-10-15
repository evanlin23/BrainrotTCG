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
  const saveName = () => {
    try {
      const next = renamePlayer(nameDraft);
      setPlayer(next);
      setNameDraft(next.name);
      setNameStatus('Display name saved.');
    } catch {
      setNameStatus("Couldn't save your name in this browser. Try again.");
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
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveName(); } }} />
      </label>
      <button type="button" className="btn btn--secondary" onClick={saveName}>Save name</button>
      <p role="status">{nameStatus || `Player ID #${player.fingerprint}`}</p>
    </section>
    <div className="personal-nav">
      <button type="button" className="btn btn--secondary" onClick={onOpenGoals}>Goals & rewards</button>
      <button type="button" className="btn btn--secondary" onClick={onOpenSave}>Save & restore</button>
    </div>
    <RewardsPanel level={level} settings={settings} onSettingsChange={onSettingsChange} packImage={packImageUrl(DEFAULT_SET_ID)} />
  </Sheet>;
}
