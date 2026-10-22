import { useId, useState, type ReactNode } from 'react';
import { POKER_HANDS, XP_PER_HAND, XP_PER_NEW_CARD, XP_PER_PACK, qualifiesForHallOfFame, xpForLevel, type HandKey, type ProfilePack, type ProfileStats } from '../../engine';
import { COLLECTIBLE_CARDS, collectibleOwned, getSetCards } from '../../data/cards';
import { SETS } from '../../content/sets';
import { toCardsWithMeta } from '../../game/pulls';
import { collectionMilestone, setProgress, titleFor } from '../../game/progression';
import PackCardViewer from '../ui/PackCardViewer';
import SetBadge from '../sets/SetBadge';
import Sheet from '../ui/Sheet';
import PullRow from './PullRow';
import '../../styles/Pulls.css';
import '../../styles/Profile.css';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** Hands worth bragging about, rarest first. */
const SHOWN_HANDS: HandKey[] = ['FIVE_OF_A_KIND', 'FOUR_OF_A_KIND', 'FULL_HOUSE', 'THREE_OF_A_KIND', 'TWO_PAIR'];

/**
 * Combos that earn bonus XP, from the engine's XP table so the list can't drift from what levels are worked out from.
 * Most XP first; combos with the same XP go rarest first (the higher multiplier).
 */
const XP_HANDS = (Object.keys(XP_PER_HAND) as HandKey[])
  .filter((h) => XP_PER_HAND[h] > 0)
  .sort((a, b) => XP_PER_HAND[b] - XP_PER_HAND[a] || POKER_HANDS[b].multiplier - POKER_HANDS[a].multiplier);
const NO_XP_HANDS = (Object.keys(XP_PER_HAND) as HandKey[]).filter((h) => XP_PER_HAND[h] === 0).map((h) => POKER_HANDS[h].name).join(' and ');

interface ProfileSummaryProps {
  stats: ProfileStats;
  /** Under the level, e.g. a share button. */
  actions?: ReactNode;
  /** Next to the level, e.g. "claimed" while a viewer is still checking it. */
  levelNote?: ReactNode;
  /** While a viewer is still re-opening packs, the other numbers are "so far". */
  partial?: boolean;
  /** Overrides the footnote when the check stopped early, so it says which packs the numbers come from. */
  partialNote?: string;
  /** Replaces the built-in pack viewer (your own profile opens the share sheet instead). */
  onOpenPack?: (pack: ProfilePack) => void;
  /** After a best pull's hand, e.g. whether this device sent it to the Hall of Fame (your own profile only). */
  packBadge?: (pack: ProfilePack) => ReactNode;
  /**
   * Your own profile leads with its verified Best pack and Best card (BestHighlights), so the best-score
   * stat and the Best pulls list, which would only repeat them, are left out.
   */
  highlighted?: boolean;
}

/** Level, the numbers that matter, best pulls, then the collection score and cards by set. Same for your profile and someone else's. */
const ProfileSummary = ({ stats, actions, levelNote, partial = false, partialNote, onOpenPack, packBadge, highlighted = false }: ProfileSummaryProps) => {
  const [open, setOpen] = useState<ProfilePack | null>(null);
  const bestId = useId();
  const collectionId = useId();
  const floor = xpForLevel(stats.level);
  const ceiling = xpForLevel(stats.level + 1);
  const best = highlighted ? [] : stats.best.filter((p) => p.cards.length > 0).slice(0, 3);
  const hands = SHOWN_HANDS.filter((h) => stats.hands[h]);
  const sets = SETS.filter((s) => stats.uniqueBySet[s.id]);
  const { current: milestone, next: nextMilestone } = collectionMilestone(stats.points);
  const milestoneFloor = milestone?.points ?? 0;

  return (
    <div className={`profile-summary ${partial ? 'is-partial' : ''}`}>
      <section className="profile-level" aria-label={`Level ${stats.level}`}>
        <span className="profile-level-head">
          <span className="profile-level-label">
            Level <span className="tabular">{stats.level}</span>
            <span className="profile-title"> · {titleFor(stats.level)}</span>
            {levelNote && <span className="profile-so-far"> {levelNote}</span>}
          </span>
          <span className="profile-level-next tabular">
            {stats.xp.toLocaleString()} / {ceiling.toLocaleString()} XP
          </span>
        </span>
        <span className="progress" aria-hidden="true">
          <span style={{ width: `${((stats.xp - floor) / (ceiling - floor)) * 100}%` }} />
        </span>
        {actions && <span className="profile-level-actions">{actions}</span>}
      </section>

      <dl className="profile-stats">
        <div>
          <dd className="tabular">{stats.packs.toLocaleString()}</dd>
          <dt>
            {stats.packs === 1 ? 'pack' : 'packs'}
            {partialNote && '*'}
          </dt>
        </div>
        <div>
          <dd className="tabular">
            {collectibleOwned(stats.uniqueBySet)}/{COLLECTIBLE_CARDS.length}
          </dd>
          <dt>cards{partial && '*'}</dt>
        </div>
        <div>
          <dd className="tabular">{stats.holos.toLocaleString()}</dd>
          <dt>holo{partial && '*'}</dt>
        </div>
        {!highlighted && (
          <div>
            <dd className="tabular" title={(stats.best[0]?.score.score ?? 0).toLocaleString()}>
              {partial && !stats.best[0] ? '…' : compact.format(stats.best[0]?.score.score ?? 0)}
            </dd>
            <dt>best score{partial && '*'}</dt>
          </div>
        )}
      </dl>
      {hands.length > 0 && (
        <p className="profile-hands">
          {hands.map((h, i) => (
            <span key={h}>
              {i > 0 && ' · '}
              <span className="tabular">{stats.hands[h]}</span> × {POKER_HANDS[h].name}
            </span>
          ))}
        </p>
      )}
      {partial && <p className="profile-footnote">{partialNote ?? '* so far, while the rest of the packs are re-opened'}</p>}
      <details className="profile-how">
        <summary>What do these numbers mean?</summary>
        <p>
          <strong>XP</strong> comes from three things: <span className="tabular">{XP_PER_PACK}</span> XP for every pack opened,{' '}
          <span className="tabular">{XP_PER_NEW_CARD}</span> XP the first time you pull each different card (holo or not), and a combo bonus for the pack:{' '}
          {XP_HANDS.map((h, i) => (
            <span key={h}>
              {i > 0 && ', '}
              {POKER_HANDS[h].name} <span className="tabular">+{XP_PER_HAND[h].toLocaleString()}</span>
            </span>
          ))}
          . {NO_XP_HANDS} earn no bonus. Level {stats.level + 1} needs <span className="tabular">{ceiling.toLocaleString()}</span> XP.
        </p>
        <p>
          <strong>packs</strong> is how many packs opened. <strong>cards</strong> is how many different cards you have out of those you can still pull.{' '}
          <strong>holo</strong> counts every holo card pulled, repeats included.{' '}
          {!highlighted && <><strong>best score</strong> is your highest Brainrot Score in a single pack.{' '}</>}
          <strong>Collection score</strong> adds up the points of every card you have pulled, with no combo multipliers.
        </p>
      </details>

      {best.length > 0 && (
        <section className="profile-block" aria-labelledby={bestId}>
          <h3 id={bestId} className="section-title profile-heading">Best pulls</h3>
          <ul className="pulls-list">
            {best.map((pack) => (
              <PullRow
                key={pack.nonce}
                cards={toCardsWithMeta(pack.cards, pack.set)}
                set={pack.set}
                setId={pack.set.id}
                hand={pack.score.hand.name}
                score={pack.score.score}
                meta={<>ticket #{pack.nonce}</>}
                worthy={qualifiesForHallOfFame(pack.score)}
                badge={packBadge?.(pack)}
                onClick={() => (onOpenPack ? onOpenPack(pack) : setOpen(pack))}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="profile-block profile-collection" aria-labelledby={collectionId}>
        <h3 id={collectionId} className="section-title profile-heading">
          Collection{partial && '*'}
        </h3>
        <div className="profile-collection-score">
          <span className="profile-collection-head">
            <span>
              <span className="profile-collection-label">Collection score</span>{' '}
              <span className="profile-collection-tier">{milestone ? milestone.name : 'No milestone yet'}</span>
            </span>
            <span className="profile-level-next tabular">
              {stats.points.toLocaleString()}
              {nextMilestone && ` / ${nextMilestone.points.toLocaleString()} for ${nextMilestone.name}`}
            </span>
          </span>
          <span className="progress" aria-hidden="true">
            <span style={{ width: `${nextMilestone ? ((stats.points - milestoneFloor) / (nextMilestone.points - milestoneFloor)) * 100 : 100}%` }} />
          </span>
        </div>
        {sets.length > 0 && (
          <>
            <ul className="profile-sets" aria-label="Cards by set">
              {sets.map((set) => {
                const have = stats.uniqueBySet[set.id] ?? 0;
                const size = getSetCards(set.id).length;
                const done = setProgress(have, stats.holoUniqueBySet[set.id] ?? 0, size);
                const [a = '#ff3df2', b = '#29f0ff'] = set.palette ?? [];
                return (
                  <li key={set.id} style={{ '--set-a': a, '--set-b': b } as React.CSSProperties}>
                    <span className="profile-set-name">
                      <span className="profile-set-title">{set.name}</span>
                      {done && <SetBadge done={done} />}
                    </span>
                    <span className="profile-set-bar" aria-hidden="true">
                      <span style={{ width: `${(have / size) * 100}%` }} />
                    </span>
                    <span className="profile-set-count tabular">
                      {have}/{size}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="profile-footnote profile-sets-key">
              <strong>Complete</strong>: every card in the set. <strong>Master</strong>: every card in the set as a holo.
            </p>
          </>
        )}
      </section>

      {open && (
        <Sheet title={open.score.hand.name} subtitle={`${open.set.name} · ticket #${open.nonce}`} onClose={() => setOpen(null)} size="md">
          <PackCardViewer cards={toCardsWithMeta(open.cards, open.set).map((c) => ({ ...c, isRevealed: true }))} displayMode="carousel" set={open.set} />
        </Sheet>
      )}
    </div>
  );
};

export default ProfileSummary;
