import { memo, useCallback, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import CardViewerModal from '../cards/CardViewerModal';
import CardImage from '../cards/CardImage';
import SetBadge from '../sets/SetBadge';
import { CARD_RARITIES, cardPoints, COLLECTIBLE_CARDS, getSetCards, type Card } from '../../data/cards';
import { isOpenable, SETS } from '../../content/sets';
import { FINISH_INFO, bestFinish } from '../../game/modifiers';
import { cardMatches, FINISH_CHOICES, isFiltering, NO_FILTERS, RARITY_CHOICES, type CollectionFilters } from '../../game/collectionFilter';
import { setProgress } from '../../game/progression';
import { isCardOwned, ownedVersions } from '../../game/versions';
import type { Finish, SetDefinition } from '../../engine';
import type { CollectionItem } from '../../types';
import '../../styles/Collection.css';
import '../../styles/CollectionLabel.css';

interface CollectionBrowserProps {
  collection: Record<string, CollectionItem>;
  /** The set packs are opened from (App's selected set), so the cards you just pulled show open. */
  recentSetId?: string;
}

type Owned = { normalCount: number; holoCount: number; finishes?: Partial<Record<Finish, number>>; misprints?: number };

/**
 * Grid pockets the page opens with (#344). The era you open packs from always opens (or the newest
 * started one, without that); then the other started eras open newest first while they fit. The rest
 * start collapsed behind their header, so a big collection mounts a bounded number of tiles, and no
 * card art or finish work, instead of every card of every era.
 */
const INITIAL_POCKETS = 24;

/** Which started eras open with the page: the recent one, then newest first while the budget lasts. */
const initiallyOpen = (started: { set: { id: string }; pockets: number }[], recentSetId?: string) => {
  const newestFirst = [...started].reverse();
  const recent = newestFirst.findIndex((s) => s.set.id === recentSetId);
  if (recent > 0) newestFirst.unshift(...newestFirst.splice(recent, 1));
  let pockets = 0;
  let fits = true;
  return Object.fromEntries(newestFirst.map((section, index) => {
    pockets += section.pockets;
    fits = fits && (index === 0 || pockets <= INITIAL_POCKETS);
    return [section.set.id, fits];
  }));
};

interface EraSectionProps {
  set: SetDefinition;
  cards: Card[];
  have: number;
  holo: number;
  done: ReturnType<typeof setProgress>;
  expanded: boolean;
  gridId: string;
  owned: Map<string, Owned>;
  filteredCardKeys?: Set<string> | null;
  onToggle: (setId: string) => void;
  onSelect: (card: Card, counts: Owned) => void;
}

/**
 * One started era: its header toggle and, while open, its grid. Memoized, with stable props, so
 * opening one era or tapping a card re-renders only what changed, not every open era's tiles.
 */
const EraSection = memo(({ set, cards, have, holo, done, expanded, gridId, owned, filteredCardKeys, onToggle, onSelect }: EraSectionProps) => {
  const [a = '#ff3df2', b = '#29f0ff'] = set.palette ?? [];
  const holoPct = cards.length > 0 ? Math.round((holo / cards.length) * 100) : 0;
  return (
    <section className="collection-set" style={{ '--set-a': a, '--set-b': b } as React.CSSProperties}>
      <header className="collection-set-header">
        <h3>
          <button
            type="button"
            className="collection-set-toggle"
            aria-expanded={expanded}
            aria-controls={expanded ? gridId : undefined}
            onClick={() => onToggle(set.id)}
          >
            <span className="collection-set-name">{set.name}</span>
            <span className="collection-set-era">
              {set.era}
              {set.archivedAt && <span className="collection-set-archived">Archived</span>}
              {done && (
                <>
                  <SetBadge done={done} />
                  <span className="sr-only">{done === 'master' ? ': every card as a holo' : ': every card collected'}</span>
                </>
              )}
              {holo > 0 && done !== 'master' && (
                <span className="collection-set-holo-pct tabular" title={`${holo} of ${cards.length} cards collected as holo`}>
                  {holoPct}% holo
                </span>
              )}
            </span>
            <span className="collection-set-count tabular">
              {have}/{cards.length}
              <span className="sr-only"> collected</span>
            </span>
            <ChevronDown className="collection-set-chevron" aria-hidden="true" />
          </button>
        </h3>
        <span className="collection-set-bar" aria-hidden="true">
          <span style={{ width: `${(have / cards.length) * 100}%` }} />
          {holo > 0 && <span className="collection-set-bar-holo" style={{ width: `${(holo / cards.length) * 100}%` }} />}
        </span>
      </header>
      {expanded && (
        <ul className="collection-grid" id={gridId}>
          {cards
            .map((card, index) => ({ card, number: `${String(index + 1).padStart(3, '0')}/${String(cards.length).padStart(3, '0')}` }))
            .filter(({ card }) => (filteredCardKeys ? filteredCardKeys.has(card.key) : true) && (owned.has(card.key) || isOpenable(set)))
            .map(({ card, number }) => {
              const counts = owned.get(card.key);
              // Under every pocket, owned or not: its collector number and rarity, like a sleeve label.
              const label = (
                <span className="collection-label tabular" aria-hidden="true">
                  {number} <span className={`collection-label-rarity ${card.rarity.toLowerCase()}`}>{CARD_RARITIES[card.rarity].symbol}</span>
                </span>
              );
              if (!counts) {
                return (
                  <li key={card.key} aria-label={`${number}, ${CARD_RARITIES[card.rarity].name}, not collected yet`}>
                    <span className="collection-slot" />
                    {label}
                  </li>
                );
              }
              const total = counts.normalCount + counts.holoCount;
              // The rarest finish owned recolours the tile's printed frame; misprints get a mark.
              const finish = bestFinish(counts.finishes);
              const extras = [finish && `best finish ${FINISH_INFO[finish].name}`, counts.misprints && `${counts.misprints} misprint${counts.misprints === 1 ? '' : 's'}`].filter(Boolean).join(', ');
              return (
                <li key={card.key}>
                  <button
                    type="button"
                    className={`collection-item ${card.rarity.toLowerCase()} ${counts.holoCount > 0 ? 'holo' : ''} ${finish ? `has-finish finish-${finish.toLowerCase()}` : ''}`}
                    style={finish ? ({ '--finish': FINISH_INFO[finish].color } as React.CSSProperties) : undefined}
                    onClick={() => onSelect(card, counts)}
                    aria-label={`${card.name}, ${number}, ${CARD_RARITIES[card.rarity].name}, ${total} owned${counts.holoCount ? `, ${counts.holoCount} holo` : ''}${extras ? `, ${extras}` : ''}`}
                  >
                    <CardImage src={card.image} finish={finish} thumbnail alt="" loading="lazy" decoding="async" />
                    {(finish || (counts.misprints ?? 0) > 0) && (
                      <span className="collection-mods" aria-hidden="true">
                        {finish && FINISH_INFO[finish].name}
                        {finish && counts.misprints ? ' · ' : ''}
                        {counts.misprints ? 'Misprint' : ''}
                      </span>
                    )}
                    {(total > 1 || counts.holoCount > 0) && (
                      <span className="collection-count tabular">
                        ×{total}
                      </span>
                    )}
                  </button>
                  {label}
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
});
EraSection.displayName = 'EraSection';

/**
 * Eras you've started, in timeline order, with every card (the missing ones as empty slots), each
 * header a button that shows or hides its grid; then the eras you haven't started, one line each.
 */
const CollectionBrowser = ({ collection, recentSetId }: CollectionBrowserProps) => {
  const [selected, setSelected] = useState<{ card: Card } & Owned | null>(null);
  const [filters, setFilters] = useState<CollectionFilters>(NO_FILTERS);
  const [filteredOpen, setFilteredOpen] = useState<Record<string, boolean>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const filtering = isFiltering(filters);

  const patchFilters = useCallback((change: Partial<CollectionFilters>) => setFilters((current) => ({ ...current, ...change })), []);
  // Both buttons that call these unmount with the change, so focus goes to the search box, not to the page.
  const clearSearch = useCallback(() => {
    patchFilters({ query: '' });
    searchRef.current?.focus();
  }, [patchFilters]);
  const resetFilters = useCallback(() => {
    setFilters(NO_FILTERS);
    setFilteredOpen({});
    searchRef.current?.focus();
  }, []);

  const owned = useMemo(() => {
    const map = new Map<string, Owned>();
    for (const item of Object.values(collection)) {
      if (!item?.card?.key || !isCardOwned(item)) continue;
      map.set(item.card.key, {
        normalCount: item.normalCount || item.count || 0,
        holoCount: item.holoCount || 0,
        finishes: item.finishes,
        misprints: item.misprints,
      });
    }
    return map;
  }, [collection]);

  const score = useMemo(
    () =>
      Object.values(collection).reduce(
        (sum, item) =>
          item?.card?.rarity && isCardOwned(item)
            ? sum + (item.normalCount || item.count || 0) * cardPoints(item.card.rarity, false) + (item.holoCount || 0) * cardPoints(item.card.rarity, true) + (item.modifierPoints ?? 0)
            : sum,
        0,
      ),
    [collection],
  );

  // Memoized with the ownership map, so each era keeps the same `cards` array between renders and
  // its memoized section can skip a render that isn't about it.
  const sections = useMemo(() => SETS.map((set) => {
    const cards = getSetCards(set.id);
    const have = cards.filter((c) => owned.has(c.key)).length;
    // An openable set shows a pocket for every card; an archived or draft one only the cards you own.
    const holo = cards.filter((c) => (owned.get(c.key)?.holoCount ?? 0) > 0).length;
    return { set, cards, have, holo, done: setProgress(have, holo, cards.length), pockets: isOpenable(set) ? cards.length : have };
  }).filter((s) => s.have > 0 || isOpenable(s.set)), [owned]);
  // What you own first (in timeline order), then the eras you haven't opened yet as one short list.
  const started = sections.filter((s) => s.have > 0);
  const notStarted = sections.filter((s) => s.have === 0);

  // Per era, the pockets the filters keep. The binder's own rule comes first (an owned card, or any
  // card of an openable era), so a filter never shows a pocket the unfiltered binder hides: Missing
  // only lists nothing for a draft or archived era. Progress and collector numbers read the unfiltered cards.
  const matches = useMemo(() => {
    if (!filtering) return null;
    const byEra = new Map<string, Set<string>>();
    for (const { set, cards } of sections) {
      const keys = new Set<string>();
      for (const card of cards) {
        const counts = owned.get(card.key);
        if ((counts || isOpenable(set)) && cardMatches(card, counts, filters)) keys.add(card.key);
      }
      byEra.set(set.id, keys);
    }
    return byEra;
  }, [filtering, sections, owned, filters]);
  const hasMatch = (setId: string) => (matches?.get(setId)?.size ?? 0) > 0;
  const visibleStarted = matches ? started.filter((s) => hasMatch(s.set.id)) : started;
  const visibleNotStarted = matches ? notStarted.filter((s) => hasMatch(s.set.id)) : notStarted;
  const shownCards = visibleStarted.reduce((n, s) => n + (matches?.get(s.set.id)?.size ?? 0), 0);
  const nothingMatches = filtering && visibleStarted.length === 0 && visibleNotStarted.length === 0;
  const status = !filtering ? '' : nothingMatches ? 'No cards match the active filters.'
    : `Showing ${shownCards} ${shownCards === 1 ? 'card' : 'cards'}${visibleNotStarted.length > 0 ? `, and ${visibleNotStarted.length} ${visibleNotStarted.length === 1 ? 'era' : 'eras'} not started` : ''}`;

  // Which started sets show their grid, decided when the page opens; a set started while it is
  // open shows open. Collapsing unmounts the grid, so hidden cards cost nothing.
  const [open, setOpen] = useState<Record<string, boolean>>(() => initiallyOpen(started, recentSetId));
  const gridIds = useId();
  // While filtering, the same budget applies to the matching pockets (#344): the recent era, then
  // newest first while they fit, and the rest start collapsed. A header you toggled keeps its choice.
  const filteredDefault = useMemo(() => {
    if (!matches) return {};
    const withMatches = sections
      .filter((s) => s.have > 0 && (matches.get(s.set.id)?.size ?? 0) > 0)
      .map((s) => ({ set: s.set, pockets: matches.get(s.set.id)!.size }));
    return initiallyOpen(withMatches, recentSetId);
  }, [matches, sections, recentSetId]);
  const toggleEra = useCallback((setId: string) => {
    if (filtering) {
      setFilteredOpen((current) => ({ ...current, [setId]: !(current[setId] ?? filteredDefault[setId] ?? true) }));
    } else {
      setOpen((current) => ({ ...current, [setId]: !(current[setId] ?? true) }));
    }
  }, [filtering, filteredDefault]);
  const selectCard = useCallback((card: Card, counts: Owned) => setSelected({ card, ...counts }), []);

  const uniqueOwned = COLLECTIBLE_CARDS.filter((c) => owned.has(c.key)).length;

  return (
    <>
      <div className="collection">
        <p className="page-subtitle tabular">
          {uniqueOwned}/{COLLECTIBLE_CARDS.length} cards · {score.toLocaleString()} total card points
        </p>

        <div className="collection-controls" role="search" aria-label="Search and filter the collection">
          <div className="collection-search-wrap">
            <Search className="collection-search-icon" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              className="collection-search-input"
              value={filters.query}
              onChange={(e) => patchFilters({ query: e.target.value })}
              placeholder="Search cards by name"
              aria-label="Search cards by name"
              autoComplete="off"
              spellCheck={false}
            />
            {filters.query && (
              <button type="button" className="collection-search-clear" onClick={clearSearch} aria-label="Clear search">
                <X aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="collection-filter-row">
            <select
              className="collection-select"
              value={filters.rarity}
              onChange={(e) => patchFilters({ rarity: e.target.value as CollectionFilters['rarity'] })}
              aria-label="Filter by rarity"
            >
              <option value="ALL">All rarities</option>
              {RARITY_CHOICES.map((rarity) => <option key={rarity} value={rarity}>{CARD_RARITIES[rarity].name}</option>)}
            </select>
            <select
              className="collection-select"
              value={filters.finish}
              onChange={(e) => patchFilters({ finish: e.target.value as CollectionFilters['finish'] })}
              aria-label="Filter by finish"
            >
              <option value="ALL">All finishes</option>
              <option value="ANY">Any finish</option>
              {FINISH_CHOICES.map((finish) => <option key={finish} value={finish}>{FINISH_INFO[finish].name}</option>)}
            </select>
            <button type="button" className="collection-pill-btn" aria-pressed={filters.holoOnly} onClick={() => patchFilters({ holoOnly: !filters.holoOnly })}>
              Holo only
            </button>
            <button type="button" className="collection-pill-btn" aria-pressed={filters.missingOnly} onClick={() => patchFilters({ missingOnly: !filters.missingOnly })}>
              Missing only
            </button>
            {filtering && (
              <button type="button" className="collection-reset-btn" onClick={resetFilters}>
                Clear filters
              </button>
            )}
          </div>
        </div>
        {/* Always mounted, so a change in it is announced. */}
        <p className="collection-filter-status" role="status">{status}</p>

        {visibleStarted.map(({ set, cards, have, holo, done }) => (
          <EraSection
            key={set.id}
            set={set}
            cards={cards}
            have={have}
            holo={holo}
            done={done}
            expanded={filtering ? (filteredOpen[set.id] ?? filteredDefault[set.id] ?? true) : (open[set.id] ?? true)}
            gridId={`${gridIds}-${set.id}`}
            owned={owned}
            filteredCardKeys={matches?.get(set.id) ?? null}
            onToggle={toggleEra}
            onSelect={selectCard}
          />
        ))}

        {visibleNotStarted.length > 0 && (
          <section className="collection-later">
            <h3 className="section-title">{started.length > 0 ? 'Not started yet' : 'Eras'}</h3>
            <ul>
              {visibleNotStarted.map(({ set, cards }) => (
                <li key={set.id}>
                  <span className="collection-later-name">{set.name}</span>
                  <span className="collection-later-era">{set.era}</span>
                  <span className="collection-later-count tabular">0/{cards.length}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {nothingMatches && (
          <p className="collection-empty-filter">Try fewer filters, or a shorter name.</p>
        )}

        {!filtering && uniqueOwned === 0 && <p className="collection-empty">Open packs to start your collection.</p>}
      </div>

      {selected && (
        <CardViewerModal
          card={selected.card}
          versions={ownedVersions(selected.card.key, selected.card.rarity, selected)}
          onClose={() => setSelected(null)}
          canShare
        />
      )}
    </>
  );
};

export default CollectionBrowser;
