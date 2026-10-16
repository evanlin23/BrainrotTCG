import { useMemo, useState } from 'react';
import { Check, ChevronRight, Share2 } from 'lucide-react';
import { ACHIEVEMENTS, type Achievement } from '../../data/achievements';
import type { AchievementData } from '../../types';
import type { CardWithMeta } from '../cards/Card';
import { findPackByCards } from '../../game/history';
import type { PullRef } from '../../game/pulls';
import { hydrateCard } from '../../utils/migrations';
import PackCardViewer from '../ui/PackCardViewer';
import Sheet from '../ui/Sheet';
import '../../styles/Achievements.css';

interface AchievementsSectionProps {
  unlockedAchievements: Record<string, AchievementData | number>;
  /** How far along the counting achievements are, e.g. { packs_10: [3, 10, 'packs'] }. */
  progress?: Record<string, [have: number, need: number, unit: string]>;
  /** Share the pack that unlocked one, the same way as from the profile. */
  onSharePull?: (ref: PullRef, cards: CardWithMeta[]) => void;
  /** Changes each time something links here (an achievement toast), which opens the full list. */
  openRequest?: number;
}

/** How many of the newest unlocks show before "Show all achievements". */
const RECENT = 3;

/** Older saves stored just the unlock time. */
const normalize = (data: AchievementData | number | undefined): Omit<AchievementData, 'pack'> & { pack?: CardWithMeta[] } | null => {
  if (!data) return null;
  return typeof data === 'number' ? { unlockedAt: data } : data;
};

type Unlocked = { achievement: Achievement; unlockedAt: number; pack?: CardWithMeta[]; ref?: PullRef };

/**
 * The ticket of the pack that unlocked it. Older unlocks kept only the cards, so look those up in
 * the pack history; packs from before verifiable pulls have no ticket and can't be shared.
 */
const refFor = ({ pack, ref, unlockedAt }: Unlocked): PullRef | null => {
  if (ref) return ref;
  if (!pack?.length) return null;
  const cards = pack.map((c) => hydrateCard(c));
  const entry = findPackByCards(cards.map((c) => ({ id: c.id, holo: c.isHolo, finish: c.finish, misprint: c.misprint })), cards[0].setId, unlockedAt);
  return entry && { setId: entry.setId, setVersion: entry.setVersion, nonce: entry.nonce, publicKeyHex: entry.key };
};

/**
 * The Profile page's Achievements section (#/profile, where achievement toasts lead): the count and
 * the newest unlocks, then the whole checklist, like the one printed in a pack, behind "Show all".
 * A toast's link opens that list.
 */
const AchievementsSection = ({ unlockedAchievements, progress = {}, onSharePull, openRequest }: AchievementsSectionProps) => {
  const [selected, setSelected] = useState<Unlocked | null>(null);
  const [open, setOpen] = useState(openRequest !== undefined);
  const [seenRequest, setSeenRequest] = useState(openRequest);
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    if (openRequest !== undefined) setOpen(true);
  }
  const selectedRef = useMemo(() => (selected ? refFor(selected) : null), [selected]);

  const { unlocked, locked } = useMemo(() => {
    const unlocked: Unlocked[] = [];
    const locked: Achievement[] = [];
    for (const achievement of ACHIEVEMENTS) {
      const data = normalize(unlockedAchievements[achievement.id]);
      if (data) unlocked.push({ achievement, ...data });
      else locked.push(achievement);
    }
    unlocked.sort((a, b) => b.unlockedAt - a.unlockedAt);
    return { unlocked, locked };
  }, [unlockedAchievements]);

  const percent = Math.round((unlocked.length / ACHIEVEMENTS.length) * 100);

  const unlockedItem = (entry: Unlocked) => {
    const { achievement, pack } = entry;
    const body = (
      <>
        <span className="achievement-box is-checked" aria-hidden="true">
          <Check strokeWidth={3.5} />
        </span>
        <span className="achievement-text">
          <span className="achievement-name">{achievement.name}</span>
          <span className="achievement-desc">{achievement.description}</span>
        </span>
      </>
    );
    return (
      <li key={achievement.id}>
        {pack?.length ? (
          <button type="button" className="achievement is-unlocked" onClick={() => setSelected(entry)} aria-label={`${achievement.name}: view the pack`}>
            {body}
            <ChevronRight className="achievement-chevron" aria-hidden="true" />
          </button>
        ) : (
          <div className="achievement is-unlocked">{body}</div>
        )}
      </li>
    );
  };

  return (
    <>
      <section id="achievements" className="achievements profile-section" aria-labelledby="achievements-title">
        <h2 id="achievements-title" className="section-title" tabIndex={-1}>Achievements</h2>
        <p className="achievements-count tabular">
          {unlocked.length}/{ACHIEVEMENTS.length} unlocked · {percent}%
        </p>
        <div className="progress achievements-progress" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>

        {unlocked.length > 0 && (
          <section className="achievements-group">
            <h3 className="section-title">Recently unlocked</h3>
            <ul className="achievement-list">{unlocked.slice(0, RECENT).map(unlockedItem)}</ul>
          </section>
        )}

        <details className="profile-disclosure achievements-all" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>Show all achievements ({ACHIEVEMENTS.length})</summary>
          {unlocked.length > RECENT && (
            <section className="achievements-group">
              <h3 className="section-title">Unlocked earlier</h3>
              <ul className="achievement-list">{unlocked.slice(RECENT).map(unlockedItem)}</ul>
            </section>
          )}
          {locked.length > 0 && (
            <section className="achievements-group">
              <h3 className="section-title">Still to get</h3>
              <ul className="achievement-list">
                {locked.map((achievement) => (
                  <li key={achievement.id}>
                    <div className="achievement is-locked">
                      <span className="achievement-box" aria-hidden="true" />
                      <span className="achievement-text">
                        <span className="achievement-name">{achievement.name}</span>
                        <span className="achievement-desc">{achievement.description}</span>
                      </span>
                      {progress[achievement.id] && (
                        <span className="achievement-progress tabular">
                          {Math.min(progress[achievement.id][0], progress[achievement.id][1]).toLocaleString()}/
                          {progress[achievement.id][1].toLocaleString()}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </details>
      </section>

      {selected?.pack && (
        <Sheet
          title={selected.achievement.name}
          subtitle={`The pack that unlocked it, ${new Date(selected.unlockedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`}
          onClose={() => setSelected(null)}
          size="md"
        >
          <PackCardViewer cards={selected.pack} displayMode="carousel" canShareCards />
          {onSharePull && selectedRef && (
            <button
              type="button"
              className="btn btn--secondary btn--block achievement-share"
              onClick={() => onSharePull(selectedRef, selected.pack!.map((c) => hydrateCard(c)))}
            >
              <Share2 aria-hidden="true" /> Share this pack
            </button>
          )}
        </Sheet>
      )}
    </>
  );
};

export default AchievementsSection;
