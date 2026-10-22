import { useEffect, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { SetDefinition } from '../../engine';
import { isNewSet, setCode } from '../../content/sets';
import { packThumbUrl } from '../../content/art';
import type { CollectionItem } from '../../types';
import { setProgress } from '../../game/progression';
import { isCardOwned } from '../../game/versions';
import { siteUrl } from '../../game/pulls';
import { setPagePath } from '../../game/previewLinks';
import { copyText } from '../../game/shareActions';
import Sheet from '../ui/Sheet';
import SetBadge from './SetBadge';
import '../../styles/Sets.css';

interface SetPickerProps {
  /** Timeline order, oldest first. */
  sets: SetDefinition[];
  selectedId: string;
  onSelect: (setId: string) => void;
  collection: Record<string, CollectionItem>;
  /** While a pack is being opened, switching sets would throw it away. */
  disabled?: boolean;
}

const progressOf = (set: SetDefinition, collection: Record<string, CollectionItem>) => {
  const owned = set.cards.filter((c) => isCardOwned(collection[`${set.id}/${c.id}`])).length;
  const holoOwned = set.cards.filter((c) => (collection[`${set.id}/${c.id}`]?.holoCount ?? 0) > 0).length;
  return { owned, size: set.cards.length, done: setProgress(owned, holoOwned, set.cards.length) };
};

const palette = (set: SetDefinition) => {
  const [a = '#ff3df2', b = '#29f0ff'] = set.palette ?? [];
  return { '--set-a': a, '--set-b': b } as React.CSSProperties;
};

/**
 * Which pack to open: the current era with arrows to the one before and after, and every pack in a
 * sheet. One line however many sets there are.
 */
const SetPicker = ({ sets, selectedId, onSelect, collection, disabled = false }: SetPickerProps) => {
  const [open, setOpen] = useState(false);
  // The set whose link was just copied, so "Link copied" never shows under another set. Each copy is
  // a new object, so copying the same link again starts the message's time over.
  const [copied, setCopied] = useState<{ setId: string } | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  if (sets.length < 2) return null;

  const index = Math.max(0, sets.findIndex((s) => s.id === selectedId));
  const set = sets[index];
  const older = sets[index - 1];
  const newer = sets[index + 1];
  const { owned, size, done } = progressOf(set, collection);
  // A new drop while you're on another era: a dot on the button that lists them.
  const newElsewhere = sets.some((s) => s.id !== set.id && isNewSet(s));
  // A released set's own link previews as that set in chat apps and opens the packs screen on it.
  const copySetLink = async () => {
    if (await copyText(`${siteUrl()}${setPagePath(set.id)}`)) setCopied({ setId: set.id });
  };

  return (
    <nav className="set-picker" aria-label="Choose a pack">
      <div className="set-switcher" style={palette(set)}>
        <button
          type="button"
          className="set-step"
          onClick={() => older && onSelect(older.id)}
          disabled={disabled || !older}
          aria-label={older ? `Older pack: ${older.name}` : 'No older pack'}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <button type="button" className="set-current" onClick={() => setOpen(true)} disabled={disabled} aria-haspopup="dialog">
          <span className="set-current-head">
            <span className="set-code" aria-hidden="true">
              {setCode(set)}
            </span>
            <span className="set-current-name">{set.name}</span>
          </span>
          <span className="set-current-meta">
            <span className="set-current-era">
              {set.era}
              {set.draft && <span className="set-draft"> · preview</span>}
            </span>
            <span className="tabular">
              {' '}
              · {owned}/{size}
              <span className="sr-only"> collected</span>
            </span>
            {done && <SetBadge done={done} />}
            {isNewSet(set) && <span className="set-new">New</span>}
          </span>
          <span className="set-current-all" aria-hidden="true">
            <ChevronDown />
            {newElsewhere && <span className="set-new-dot" />}
          </span>
          <span className="sr-only">
            . All {sets.length} packs{newElsewhere ? ', a new one is out' : ''}
          </span>
        </button>
        <button
          type="button"
          className="set-step"
          onClick={() => newer && onSelect(newer.id)}
          disabled={disabled || !newer}
          aria-label={newer ? `Newer pack: ${newer.name}` : 'No newer pack'}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>

      {open && (
        <Sheet title="Packs" subtitle={`${sets.length} eras, newest first`} onClose={() => setOpen(false)} size="lg" className="pack-shelf">
          <ul className="pack-shelf-grid">
            {[...sets].reverse().map((s) => {
              const p = progressOf(s, collection);
              const selected = s.id === set.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`pack-tile ${selected ? 'selected' : ''}`}
                    style={palette(s)}
                    aria-pressed={selected}
                    onClick={() => {
                      onSelect(s.id);
                      setOpen(false);
                    }}
                  >
                    <span className="pack-tile-art">
                      <img src={packThumbUrl(s.id)} alt="" loading="lazy" draggable="false" />
                      {isNewSet(s) ? <span className="pack-tile-flag">New</span> : s.draft && <span className="pack-tile-flag is-preview">Preview</span>}
                    </span>
                    <span className="pack-tile-name">
                      <span className="set-code" aria-hidden="true">
                        {setCode(s)}
                      </span>{' '}
                      {s.name}
                    </span>
                    <span className="pack-tile-meta">{s.era}</span>
                    <span className="pack-tile-progress">
                      <span className="pack-tile-bar" aria-hidden="true">
                        <span style={{ width: `${(p.owned / p.size) * 100}%` }} />
                      </span>
                      <span className="tabular">
                        {p.owned}/{p.size}
                        <span className="sr-only"> collected</span>
                      </span>
                      {p.done && <SetBadge done={p.done} />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!set.draft && (
            <p className="pack-shelf-share">
              <button type="button" className="btn btn--secondary btn--sm" onClick={copySetLink}>
                Copy link to {set.name}
              </button>
              <span role="status">{copied?.setId === set.id ? 'Link copied' : ''}</span>
            </p>
          )}
        </Sheet>
      )}
    </nav>
  );
};

export default SetPicker;
