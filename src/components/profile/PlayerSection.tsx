import { useEffect, useRef, useState } from 'react';
import { MAX_NAME_LENGTH, normalizeName } from '../../engine';
import { getPlayer, renamePlayer, type RenameResult } from '../../game/player';
import type { Settings } from '../../types';
import RewardsPanel from './RewardsPanel';
import PackCacheNote from './PackCacheNote';
import { packImageUrl } from '../../content/art';
import { DEFAULT_SET_ID } from '../../content/sets';
import '../../styles/Settings.css';
import '../../styles/Pulls.css';
import '../../styles/Profile.css';

const SAVE_FAILED = "Couldn't save your name in this browser. Try again.";
const SAVE_STALE = "Your name wasn't saved: this save changed in another tab. Reload to continue with that save.";

type Player = ReturnType<typeof getPlayer>;

interface PlayerSectionProps {
  /** Null while saved packs are still being read (or couldn't be). */
  level: number | null;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  /** Go to Settings, Save & backup. */
  onOpenSave: () => void;
  /** A new name was stored. */
  onRenamed?: (player: Player) => void;
  /** Whether this tab may still write its save (false once another tab switched or replaced it). */
  canSave: () => boolean;
  /** Storing the draft on the way out of the page failed, so the app can warn that it wasn't kept. */
  onSaveFailed: () => void;
}

/** The Profile page's player: name, ID and level rewards. A local identity, not an online sign-in. */
export default function PlayerSection({ level, settings, onSettingsChange, onOpenSave, onRenamed, canSave, onSaveFailed }: PlayerSectionProps) {
  const [player, setPlayer] = useState(getPlayer);
  /** The player this page renames: a save stored under another key meanwhile is never renamed. */
  const [playerKey] = useState(player.publicKeyHex);
  const rename = (draft: string): RenameResult => (canSave() ? renamePlayer(draft, playerKey) : { status: 'stale' });
  const [nameDraft, setNameDraft] = useState(player.name);
  const [nameStatus, setNameStatus] = useState('');
  /** Counts failed saves; a repeat of the same failure remounts the status text so it is announced again. */
  const [failures, setFailures] = useState(0);
  /** The draft whose last save failed, and whether it was refused as stale; leaving the page doesn't write it again. */
  const failedDraft = useRef<{ draft: string; stale: boolean } | null>(null);
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
    const result = rename(nameDraft);
    if (result.status === 'stale') {
      failedDraft.current = { draft: nameDraft, stale: true };
      setNameStatus(SAVE_STALE);
      setFailures((count) => count + 1);
      return result.status;
    }
    setPlayer(result.player);
    if (result.status === 'saved') onRenamed?.(result.player);
    failedDraft.current = result.status === 'failed' ? { draft: nameDraft, stale: false } : null;
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
  // Leaving the page (a tab, Back, Close) keeps an edited draft the way leaving the field does, unless
  // it is the draft that just failed. A draft that still matches the name this page loaded or stored
  // is never written, so it can't undo a rename made in another tab. A refused write is reported,
  // including the one that just failed: its inline line leaves with the page. A stale save isn't,
  // since its banner already says so.
  const leave = useRef(() => {});
  useEffect(() => {
    leave.current = () => {
      const clean = normalizeName(nameDraft);
      if (!clean || clean === player.name) return;
      const failed = failedDraft.current;
      if (failed?.draft === nameDraft) {
        if (!failed.stale) onSaveFailed();
        return;
      }
      if (rename(nameDraft).status === 'failed') onSaveFailed();
    };
  });
  useEffect(() => () => leave.current(), []);
  return <section id="player" className="settings-group profile-section" aria-labelledby="player-title">
    <h2 id="player-title" className="section-title" tabIndex={-1}>Player</h2>
    <p className="share-note">
      Your player is saved in this browser. Back up your save to keep your player key:{' '}
      <button type="button" className="link-btn" onClick={onOpenSave}>Save &amp; backup</button>
    </p>
    <div className="player-name">
      <label className="settings-field">
        <span className="settings-label">Name shown on shared pulls</span>
        <input className="settings-input" value={nameDraft} autoComplete="nickname" spellCheck={false}
          onChange={(event) => {
            setNameDraft(Array.from(event.target.value).slice(0, MAX_NAME_LENGTH).join(''));
            setNameStatus('');
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
          if (blurSaved && failedDraft.current?.draft === nameDraft) return;
          saveName();
        }}>Save name</button>
      <p>Player ID #{player.fingerprint}</p>
      {/* Only save results go in the live region, so opening or editing announces nothing. */}
      <p role="status"><span key={failures}>{nameStatus}</span></p>
    </div>
    {level === null ? (
      <PackCacheNote what="your level and rewards" />
    ) : (
      <RewardsPanel level={level} settings={settings} onSettingsChange={onSettingsChange} packImage={packImageUrl(DEFAULT_SET_ID)} />
    )}
  </section>;
}
