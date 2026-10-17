import { useEffect, useId, useRef, useState } from 'react';
import { MAX_NAME_LENGTH, normalizeName } from '../../engine';
import { getPlayer, renamePlayer, type RenameResult } from '../../game/player';
import '../../styles/Settings.css';
import '../../styles/Profile.css';

const SAVE_FAILED = "Couldn't save your name in this browser. Try again.";
const SAVE_STALE = "Your name wasn't saved: this save changed in another tab. Reload to continue with that save.";

type Player = ReturnType<typeof getPlayer>;

interface PlayerSectionProps {
  /** A new name was stored. */
  onRenamed?: (player: Player) => void;
  /** Whether this tab may still write its save (false once another tab switched or replaced it). */
  canSave: () => boolean;
  /** Storing the draft on the way out of the page failed, so the app can warn that it wasn't kept. */
  onSaveFailed: () => void;
}

/**
 * The Profile page's header: the player's name and ID, with "Edit name" opening the name field in
 * place. A local identity, not an online sign-in.
 */
export default function PlayerSection({ onRenamed, canSave, onSaveFailed }: PlayerSectionProps) {
  const [player, setPlayer] = useState(getPlayer);
  /** The player this page renames: a save stored under another key meanwhile is never renamed. */
  const [playerKey] = useState(player.publicKeyHex);
  const rename = (draft: string): RenameResult => (canSave() ? renamePlayer(draft, playerKey) : { status: 'stale' });
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(player.name);
  const [nameStatus, setNameStatus] = useState('');
  /** Counts failed saves; a repeat of the same failure remounts the status text so it is announced again. */
  const [failures, setFailures] = useState(0);
  /** The draft whose last save failed, and whether it was refused as stale; leaving the page doesn't write it again. */
  const failedDraft = useRef<{ draft: string; stale: boolean } | null>(null);
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  /** Set when the field closes, so focus goes back to "Edit name" instead of being lost. */
  const returnFocus = useRef(false);

  useEffect(() => {
    if (editing) input.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };

  /** Put the stored name back and close the field without writing anything. */
  const cancel = () => {
    setNameDraft(player.name);
    setNameStatus('');
    failedDraft.current = null;
    close();
  };

  /**
   * Store the draft if it is a valid, changed name. Only a stored name is reported as saved, and only
   * then (or when nothing changed) does the field close; a refused write keeps the draft open so the
   * player can retry.
   */
  const saveName = () => {
    const result = rename(nameDraft);
    if (result.status === 'stale') {
      failedDraft.current = { draft: nameDraft, stale: true };
      setNameStatus(SAVE_STALE);
      setFailures((count) => count + 1);
      return;
    }
    setPlayer(result.player);
    if (result.status === 'saved') onRenamed?.(result.player);
    failedDraft.current = result.status === 'failed' ? { draft: nameDraft, stale: false } : null;
    switch (result.status) {
      case 'saved':
        setNameDraft(result.player.name);
        setNameStatus('Display name saved.');
        close();
        break;
      case 'failed':
        setNameStatus(SAVE_FAILED);
        setFailures((count) => count + 1);
        break;
      case 'blank':
        setNameDraft(result.player.name);
        setNameStatus("A name can't be blank, so your current name stays.");
        break;
      case 'blocked':
        // The draft stays in the field to edit; nothing was written.
        setNameStatus("That name isn't allowed here. Try another one; your current name stays.");
        setFailures((count) => count + 1);
        break;
      case 'unchanged':
        // Nothing was written, so whatever the status line says stays true.
        setNameDraft(result.player.name);
        close();
    }
  };
  // Leaving the page (a tab, Back, Close) keeps an edited draft, unless it is the draft that just
  // failed. A draft that still matches the name this page loaded or stored is never written, so it
  // can't undo a rename made in another tab. A refused write is reported, including the one that just
  // failed: its inline line leaves with the page. A stale save isn't, since its banner already says so.
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

  return (
    <section id="player" className="profile-identity" aria-labelledby="player-title">
      <div className="profile-identity-head">
        <div className="profile-identity-text">
          <h2 id="player-title" className="profile-identity-name" tabIndex={-1}>{player.name}</h2>
          <p className="profile-identity-id">
            Player ID <span className="profile-identity-fp">#{player.fingerprint}</span>
          </p>
        </div>
        {!editing && (
          <button ref={editButton} type="button" className="btn btn--secondary btn--sm" onClick={() => setEditing(true)}>
            Edit name
          </button>
        )}
      </div>
      {editing && (
        <form
          className="profile-name-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveName();
          }}
        >
          <label className="profile-name-label" htmlFor={inputId}>Name shown on shared pulls</label>
          <div className="profile-name-row">
            <input
              ref={input}
              id={inputId}
              className="settings-input profile-name-input"
              value={nameDraft}
              autoComplete="nickname"
              spellCheck={false}
              onChange={(event) => {
                setNameDraft(Array.from(event.target.value).slice(0, MAX_NAME_LENGTH).join(''));
                setNameStatus('');
                failedDraft.current = null;
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                // Escape only closes the field: it doesn't also close the page or a sheet behind it.
                event.preventDefault();
                event.stopPropagation();
                cancel();
              }}
            />
            <span className="profile-name-actions">
              <button type="submit" className="btn btn--primary btn--sm">Save</button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={cancel}>Cancel</button>
            </span>
          </div>
          <p className="profile-name-hint">Shown on the pulls and profile you share.</p>
        </form>
      )}
      {/* Only save results go in the live region, so opening or editing announces nothing. */}
      <p role="status" className="profile-name-status"><span key={failures}>{nameStatus}</span></p>
    </section>
  );
}
