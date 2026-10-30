import { useId } from 'react';
import { getLatestSet } from '../../content/sets';
import type { RecordBook as Records, Standing } from '../../game/personalRecords';
import '../../styles/Profile.css';

interface RecordBookProps {
  book: Records;
  /** Saved packs are still being read: the records that read cards (holos, droughts) aren't counted yet. */
  cardsPending?: boolean;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const holos = (n: number) => plural(n, 'holo', 'holos');
const packs = (n: number) => plural(n, 'pack', 'packs');
const score = (n: number) => n.toLocaleString();
const date = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

interface RecordProps {
  label: string;
  standing: Standing | null;
  format: (n: number) => string;
  /** What the record means before there is anything to count. */
  none: string;
  pending?: boolean;
}

/** One record: its value and what it beat, or the value to beat while none is set (Strava's rule). */
const RecordRow = ({ label, standing, format, none, pending }: RecordProps) => (
  <div className="record-book-item">
    <dt>{label}</dt>
    <dd>
      {pending ? (
        <>
          <span className="record-book-value">Counting…</span>
          <span className="record-book-detail">Reading your saved packs</span>
        </>
      ) : !standing ? (
        <>
          <span className="record-book-value">None yet</span>
          <span className="record-book-detail">{none}</span>
        </>
      ) : standing.previous === null ? (
        <>
          <span className="record-book-value">Not set yet</span>
          <span className="record-book-detail tabular">Beat {format(standing.value)} to set it</span>
        </>
      ) : (
        <>
          <span className="record-book-value tabular">{format(standing.value)}</span>
          <span className="record-book-detail tabular">
            previous {format(standing.previous)} · {date(standing.at)}
          </span>
        </>
      )}
    </dd>
  </div>
);

/**
 * Personal records (#1287, Spec 2 on #757): records against yourself only, kept apart from Achievements as
 * Duolingo keeps Personal Records apart from Awards. Each needs a value to beat, so the first value only
 * sets the bar. Derived from this player's history on each read (personalRecords' recordBook).
 */
const RecordBook = ({ book, cardsPending = false }: RecordBookProps) => {
  const titleId = useId();
  const empty = book.bestPackBySet.length === 0 && !book.mostHolos && !book.mostPacksInADay && !book.longestDroughtBroken;
  return (
    <section className="record-book profile-section" aria-labelledby={titleId}>
      <h2 id={titleId} className="section-title">Personal records</h2>
      {empty && !cardsPending ? (
        <p className="record-book-note">No records yet. Your first pack sets the bar, and a later pack that beats it sets a record.</p>
      ) : (
        <>
          <dl className="record-book-list">
            <RecordRow label="Most holos in a pack" standing={book.mostHolos} format={holos} none="No pack's cards are saved here yet" pending={cardsPending} />
            <RecordRow label="Most packs in a day" standing={book.mostPacksInADay} format={packs} none="No packs opened yet" />
            <RecordRow
              label="Longest Brainrot drought broken"
              standing={book.longestDroughtBroken}
              format={packs}
              none="No Brainrot has ended a drought yet"
              pending={cardsPending}
            />
          </dl>
          {book.bestPackBySet.length > 0 && (
            <>
              <h3 className="record-book-subtitle">Best pack by set</h3>
              <dl className="record-book-list">
                {book.bestPackBySet.map(({ setId, ...standing }) => (
                  <RecordRow key={setId} label={getLatestSet(setId)?.name ?? setId} standing={standing} format={score} none="" />
                ))}
              </dl>
            </>
          )}
          <p className="record-book-note">
            A record needs a value to beat: the first only sets the bar, and a tie keeps the earlier one. Counts this
            player's packs recorded on this device, each ticket once; days are this device's calendar days.
          </p>
        </>
      )}
    </section>
  );
};

export default RecordBook;
