import { useMemo, useState, type ReactNode } from 'react';
import CardViewerModal from '../cards/CardViewerModal';
import CardImage from '../cards/CardImage';
import Sheet from '../ui/Sheet';
import { CARD_RARITIES, cardPoints, COLLECTIBLE_CARDS, getSetCards, type Card } from '../../data/cards';
import { isOpenable, SETS } from '../../content/sets';
import { FINISH_INFO, bestFinish } from '../../game/modifiers';
import { ownedVersions } from '../../game/versions';
import type { Finish } from '../../engine';
import type { CollectionItem } from '../../types';
import '../../styles/Collection.css';

interface CollectionBrowserProps {
  collection: Record<string, CollectionItem>;
  onClose: () => void;
  navigation?: ReactNode;
}

type Owned = { normalCount: number; holoCount: number; finishes?: Partial<Record<Finish, number>>; misprints?: number };

/**
 * Eras you've started, in timeline order, with every card (the missing ones as empty slots);
 * then the eras you haven't started, one line each.
 */
const CollectionBrowser = ({ collection, onClose, navigation }: CollectionBrowserProps) => {
  const [selected, setSelected] = useState<{ card: Card } & Owned | null>(null);

  const owned = useMemo(() => {
    const map = new Map<string, Owned>();
    for (const item of Object.values(collection)) {
      if (!item?.card?.key) continue;
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
          item?.card?.rarity
            ? sum + (item.normalCount || item.count || 0) * cardPoints(item.card.rarity, false) + (item.holoCount || 0) * cardPoints(item.card.rarity, true) + (item.modifierPoints ?? 0)
            : sum,
        0,
      ),
    [collection],
  );

  const sections = SETS.map((set) => {
    const cards = getSetCards(set.id);
    const have = cards.filter((c) => owned.has(c.key)).length;
    return { set, cards, have };
  }).filter((s) => s.have > 0 || isOpenable(s.set));
  // What you own first (in timeline order), then the eras you haven't opened yet as one short list.
  const started = sections.filter((s) => s.have > 0);
  const notStarted = sections.filter((s) => s.have === 0);

  const uniqueOwned = COLLECTIBLE_CARDS.filter((c) => owned.has(c.key)).length;

  return (
    <>
      <Sheet
        title="My cards"
        subtitle={
          <span className="tabular">
            {uniqueOwned}/{COLLECTIBLE_CARDS.length} cards · {score.toLocaleString()} Brainrot Score
          </span>
        }
        onClose={onClose}
        size="lg"
        className="collection"
      >
        {navigation}
        {started.map(({ set, cards, have }) => {
          const [a = '#ff3df2', b = '#29f0ff'] = set.palette ?? [];
          return (
            <section key={set.id} className="collection-set" style={{ '--set-a': a, '--set-b': b } as React.CSSProperties}>
              <header className="collection-set-header">
                <h3>{set.name}</h3>
                <span className="collection-set-era">
                  {set.era}
                  {set.archivedAt && <span className="collection-set-archived">Archived</span>}
                </span>
                <span className="collection-set-count tabular">
                  {have}/{cards.length}
                </span>
                <span className="collection-set-bar" aria-hidden="true">
                  <span style={{ width: `${(have / cards.length) * 100}%` }} />
                </span>
              </header>
              <ul className="collection-grid">
                {cards
                  .map((card, index) => ({ card, number: `${String(index + 1).padStart(3, '0')}/${String(cards.length).padStart(3, '0')}` }))
                  .filter(({ card }) => owned.has(card.key) || isOpenable(set))
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
                          onClick={() => setSelected({ card, ...counts })}
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
            </section>
          );
        })}

        {notStarted.length > 0 && (
          <section className="collection-later">
            <h3 className="section-title">{started.length > 0 ? 'Not started yet' : 'Eras'}</h3>
            <ul>
              {notStarted.map(({ set, cards }) => (
                <li key={set.id}>
                  <span className="collection-later-name">{set.name}</span>
                  <span className="collection-later-era">{set.era}</span>
                  <span className="collection-later-count tabular">0/{cards.length}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {uniqueOwned === 0 && <p className="collection-empty">Open packs to start your collection.</p>}
      </Sheet>

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
