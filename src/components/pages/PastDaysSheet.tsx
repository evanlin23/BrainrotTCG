import { useEffect, useId, useState } from 'react';
import Sheet from '../ui/Sheet';
import { REPO } from '../../constants/config';
import { SETS } from '../../content/sets';
import { loadPastMonth, type PastDay, type PublishedRankings } from '../../game/publishedRankings';
import { RANKINGS_BOARD_SIZE, visitorName, type ArchivedPull } from '../../engine';

/** A UTC day (YYYY-MM-DD) or month (YYYY-MM) in words, read in UTC so it names the same day for everyone. */
const dayLabel = (day: string) => new Date(`${day}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' });

const setName = (setId: string) => SETS.find((s) => s.id === setId)?.name ?? setId;

interface PastDaysSheetProps {
  /** rankings.json as loaded: undefined while loading, null when missing or malformed. */
  rankings: PublishedRankings | null | undefined;
  onClose: () => void;
}

/**
 * Past UTC days' tops from the monthly archives (src/game/publishedRankings.ts). Archived entries carry
 * no proof, so each row opens the GitHub issue that holds it. A missing or malformed file shows a quiet
 * note in place of the list.
 */
const PastDaysSheet = ({ rankings, onClose }: PastDaysSheetProps) => {
  const id = useId();
  const months = rankings?.months ?? [];
  const [chosenMonth, setChosenMonth] = useState<string | null>(null);
  // Until a month is chosen, the sheet opens on the newest month with a closed day: the newest listed
  // month can have none yet, when only its open days have pulls. If no month has one, it opens on the
  // newest.
  const [opening, setOpening] = useState({ index: 0, done: false });
  const searching = chosenMonth === null && !opening.done;
  const month = chosenMonth ?? months[searching ? opening.index : 0] ?? null;
  const [loaded, setLoaded] = useState<{ month: string; days: PastDay[] | null } | null>(null);
  const [chosenDay, setChosenDay] = useState<string | null>(null);

  useEffect(() => {
    if (!rankings || !month) return;
    let live = true;
    loadPastMonth(rankings, month).then((days) => {
      if (!live) return;
      if (searching && days?.length === 0) {
        setOpening(({ index }) => (index + 1 < rankings.months.length ? { index: index + 1, done: false } : { index: 0, done: true }));
        return;
      }
      setLoaded({ month, days });
    });
    return () => {
      live = false;
    };
  }, [rankings, month, searching]);

  // undefined while the month loads, null when it couldn't be read.
  const days = month && loaded?.month === month ? loaded.days : undefined;
  const shown = days?.find((d) => d.day === chosenDay) ?? days?.[0];

  const note =
    rankings === undefined ? 'Loading past days…'
    : rankings === null ? "Past days aren't available right now."
    : months.length === 0 ? 'No past days yet.'
    : days === undefined ? 'Loading past days…'
    : days === null ? "This month's past days aren't available right now."
    : days.length === 0 ? 'No past days for this month.'
    : null;

  const renderEntry = (entry: ArchivedPull, rank: number) => {
    const who = visitorName(entry.name);
    const set = setName(entry.setId);
    return (
      <li key={entry.id}>
        <a
          className="hof-entry"
          href={`https://github.com/${REPO}/issues/${entry.issue}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Number ${rank + 1}: ${entry.hand} by ${who} in ${set}, score ${entry.score}, issue ${entry.issue} on GitHub`}
        >
          <span className="hof-rank tabular">{rank + 1}</span>
          <span className="hof-cards" aria-hidden="true" />
          <span className="hof-main">
            <span className="hof-hand">{entry.hand}</span>
            <span className="hof-who">{who}</span>
            <span className="hof-meta">
              {set} · issue #{entry.issue}
            </span>
          </span>
          <span className="hof-side">
            <span className="hof-score tabular">{entry.score.toLocaleString()}</span>
          </span>
        </a>
      </li>
    );
  };

  return (
    <Sheet title="Past days" subtitle={`Each UTC day's best ${RANKINGS_BOARD_SIZE}, kept once the day is over.`} onClose={onClose} className="hof-past-sheet">
      {months.length > 0 && (
        <div className="hof-past-pickers">
          <label htmlFor={`${id}-month`}>Month</label>
          <select
            id={`${id}-month`}
            value={month ?? ''}
            onChange={(event) => {
              setChosenMonth(event.target.value);
              setChosenDay(null);
            }}
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
          {days && days.length > 0 && (
            <>
              <label htmlFor={`${id}-day`}>Day</label>
              <select id={`${id}-day`} value={shown?.day ?? ''} onChange={(event) => setChosenDay(event.target.value)}>
                {days.map((d) => (
                  <option key={d.day} value={d.day}>
                    {dayLabel(d.day)}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      )}
      <p role="status" className={note ? 'hof-past-note' : 'sr-only'}>
        {note ?? (shown ? `${dayLabel(shown.day)}: ${shown.entries.length} ${shown.entries.length === 1 ? 'pull' : 'pulls'}.` : '')}
      </p>
      {shown && (
        <>
          <ol className="hof-list" aria-label={`Best pulls of ${dayLabel(shown.day)} (UTC)`}>
            {shown.entries.map((e, i) => renderEntry(e, i))}
          </ol>
          <p className="hof-past-note">
            Ranked by when each pull was received (UTC), as of the last update before the next day ended. A pull removed since is
            left out, and its place isn&apos;t refilled.
            Each row opens the GitHub issue holding its proof.
          </p>
        </>
      )}
    </Sheet>
  );
};

export default PastDaysSheet;
