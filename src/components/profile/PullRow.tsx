import type { CSSProperties, ReactNode } from 'react';
import { ChevronRight, Trophy } from 'lucide-react';
import type { SetDefinition } from '../../engine';
import { setCode } from '../../content/sets';
import { modifierClasses } from '../../game/modifiers';
import CardImage from '../cards/CardImage';
import type { CardWithMeta } from '../cards/Card';
import '../../styles/Pulls.css';

interface PullRowProps {
  /** The pack's cards as thumbnails. Null when they can't be shown: blank thumbnails and a row that can't be opened. */
  cards: CardWithMeta[] | null;
  /** Null when this build no longer has the set (the set code goes, and `setId` stands in for its name). */
  set: SetDefinition | undefined;
  setId: string;
  hand: string;
  score: number;
  /** After the set name: when the pack was opened, or which ticket it came from. */
  meta: ReactNode;
  /** The pack qualifies for Rankings, the public Hall of Fame: a trophy. */
  worthy: boolean;
  /** After the hand, e.g. whether this device sent the pack to the Hall of Fame (your own packs only). */
  badge?: ReactNode;
  onClick: () => void;
}

/** One pack in a list of packs: thumbnails, hand, set, score. Your pack list and your best pulls share it, so they can't drift apart. */
const PullRow = ({ cards, set, setId, hand, score, meta, worthy, badge, onClick }: PullRowProps) => {
  const [a = '#ff3df2', b = '#29f0ff'] = set?.palette ?? [];
  return (
    <li>
      <button type="button" className="pull-row quiet-focus" style={{ '--set-a': a, '--set-b': b } as CSSProperties} onClick={onClick} disabled={!cards}>
        <span className="pull-row-thumbs" aria-hidden="true">
          {cards
            ? cards.map((c, i) => <CardImage key={i} src={c.image} finish={c.finish} thumbnail alt="" loading="lazy" className={`${c.isHolo ? 'holo' : ''} ${modifierClasses(c)}`} />)
            : Array.from({ length: 5 }, (_, i) => <span key={i} className="pull-row-blank" />)}
        </span>
        <span className="pull-row-main">
          <span className="pull-row-hand">
            {hand}
            {worthy && (
              <>
                <Trophy className="pull-row-hof" aria-hidden="true" />
                <span className="sr-only">, qualifies for Rankings</span>
              </>
            )}
            {badge}
          </span>
          <span className="pull-row-meta">
            {set && <span className="set-code">{setCode(set)}</span>}
            <span className="pull-row-setname">{set?.name ?? setId} · </span>
            {meta}
          </span>
        </span>
        <span className="pull-row-score tabular">{score.toLocaleString()}</span>
        {cards && <ChevronRight className="pull-row-chevron" aria-hidden="true" />}
      </button>
    </li>
  );
};

export default PullRow;
