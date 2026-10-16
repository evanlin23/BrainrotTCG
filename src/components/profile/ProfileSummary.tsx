import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { POKER_HANDS, xpForLevel, type HandKey, type ProfilePack, type ProfileStats } from '../../engine';
import { COLLECTIBLE_CARDS, collectibleOwned, getSetCards } from '../../data/cards';
import { SETS, setCode } from '../../content/sets';
import { toCardsWithMeta } from '../../game/pulls';
import { collectionMilestone, setProgress, titleFor } from '../../game/progression';
import { modifierClasses } from '../../game/modifiers';
import PackCardViewer from '../ui/PackCardViewer';
import CardImage from '../cards/CardImage';
import SetBadge from '../sets/SetBadge';
import Sheet from '../ui/Sheet';
import '../../styles/Pulls.css';
import '../../styles/Profile.css';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** Hands worth bragging about, rarest first. */
const SHOWN_HANDS: HandKey[] = ['FIVE_OF_A_KIND', 'FOUR_OF_A_KIND', 'FULL_HOUSE', 'THREE_OF_A_KIND', 'TWO_PAIR'];

interface ProfileSummaryProps {
  stats: ProfileStats;
  /** Under the level, e.g. a share button. */
  actions?: ReactNode;
  /** Next to the level, e.g. "claimed" while a viewer is still checking it. */
  levelNote?: ReactNode;
  /** While a viewer is still re-opening packs, the other numbers are "so far". */
  partial?: boolean;
  /** Replaces the built-in pack viewer (your own profile opens the share sheet instead). */
  onOpenPack?: (pack: ProfilePack) => void;
}

/** Level, the numbers that matter, best pulls and collection by era. Same for your profile and someone else's. */
const ProfileSummary = ({ stats, actions, levelNote, partial = false, onOpenPack }: ProfileSummaryProps) => {
  const [open, setOpen] = useState<ProfilePack | null>(null);
  const floor = xpForLevel(stats.level);
  const ceiling = xpForLevel(stats.level + 1);
  const best = stats.best.filter((p) => p.cards.length > 0).slice(0, 3);
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
          <dt>{stats.packs === 1 ? 'pack' : 'packs'}</dt>
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
        <div>
          <dd className="tabular" title={(stats.best[0]?.score.score ?? 0).toLocaleString()}>
            {partial && !stats.best[0] ? '…' : compact.format(stats.best[0]?.score.score ?? 0)}
          </dd>
          <dt>best score{partial && '*'}</dt>
        </div>
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
      {partial && <p className="profile-footnote">* so far, while the rest of the packs are re-opened</p>}

      <section className="profile-collection" aria-label="Collection Brainrot Score">
        <span className="profile-collection-head">
          <span>
            <span className="profile-collection-label">Collection score{partial && '*'}</span>{' '}
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
      </section>

      {best.length > 0 && (
        <section>
          <h3 className="section-title profile-heading">Best pulls</h3>
          <ul className="pulls-list">
            {best.map((pack) => {
              const cards = toCardsWithMeta(pack.cards);
              const [a = '#ff3df2', b = '#29f0ff'] = pack.set.palette ?? [];
              return (
                <li key={pack.nonce}>
                  <button
                    type="button"
                    className="pull-row"
                    style={{ '--set-a': a, '--set-b': b } as React.CSSProperties}
                    onClick={() => (onOpenPack ? onOpenPack(pack) : setOpen(pack))}
                  >
                    <span className="pull-row-thumbs" aria-hidden="true">
                      {cards.map((c, i) => (
                        <CardImage key={i} src={c.image} finish={c.finish} alt="" loading="lazy" className={`${c.isHolo ? 'holo' : ''} ${modifierClasses(c)}`} />
                      ))}
                    </span>
                    <span className="pull-row-main">
                      <span className="pull-row-hand">{pack.score.hand.name}</span>
                      <span className="pull-row-meta">
                        <span className="set-code">{setCode(pack.set)}</span>
                        <span className="pull-row-setname">{pack.set.name} · </span>
                        ticket #{pack.nonce}
                      </span>
                    </span>
                    <span className="pull-row-score tabular">{pack.score.score.toLocaleString()}</span>
                    <ChevronRight className="pull-row-chevron" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {sets.length > 0 && (
        <section>
          <h3 className="section-title profile-heading">Collection by era{partial && '*'}</h3>
          <p className="profile-footnote profile-sets-key">
            <strong>Complete</strong>: every card in the set. <strong>Master</strong>: every card in the set as a holo.
          </p>
          <ul className="profile-sets">
            {sets.map((set) => {
              const have = stats.uniqueBySet[set.id] ?? 0;
              const size = getSetCards(set.id).length;
              const done = setProgress(have, stats.holoUniqueBySet[set.id] ?? 0, size);
              const [a = '#ff3df2', b = '#29f0ff'] = set.palette ?? [];
              return (
                <li key={set.id} style={{ '--set-a': a, '--set-b': b } as React.CSSProperties}>
                  <span className="profile-set-name">{set.name}</span>
                  <span className="profile-set-count tabular">
                    {done && <SetBadge done={done} />}
                    {have}/{size}
                  </span>
                  <span className="profile-set-bar" aria-hidden="true">
                    <span style={{ width: `${(have / size) * 100}%` }} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {open && (
        <Sheet title={open.score.hand.name} subtitle={`${open.set.name} · ticket #${open.nonce}`} onClose={() => setOpen(null)} size="md">
          <PackCardViewer cards={toCardsWithMeta(open.cards).map((c) => ({ ...c, isRevealed: true }))} displayMode="carousel" />
        </Sheet>
      )}
    </div>
  );
};

export default ProfileSummary;
