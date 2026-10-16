import { describe, expect, it } from 'vitest';
import {
  dailyPulls,
  firstPulls,
  HALL_OF_FAME_DAILY_TOP,
  HALL_OF_FAME_TOP,
  hallOfFameList,
  previousUtcDay,
  topPulls,
  utcDay,
  wouldJoinHallOfFame,
  type RankableEntry,
} from './hallOfFame';
import { POKER_HANDS, type PackScore } from './scoring';

const HANDS = { FH: POKER_HANDS.FULL_HOUSE, FOUR: POKER_HANDS.FOUR_OF_A_KIND, PAIR: POKER_HANDS.PAIR };

let clock = 0;
const entry = (id: string, score: number, hand: keyof typeof HANDS = 'FH', setId = 'set-a'): RankableEntry => ({
  id,
  setId,
  hand: HANDS[hand].name,
  multiplier: HANDS[hand].multiplier,
  score,
  submittedAt: new Date(Date.UTC(2026, 9, 1) + clock++ * 60_000).toISOString(),
});
const score = (points: number, hand: keyof typeof HANDS = 'FH'): PackScore => ({ score: points, hand: HANDS[hand] }) as PackScore;

describe('Hall of Fame list', () => {
  it('keeps the top pulls and the first of each hand in each set, each pull once', () => {
    const early = entry('early-fh', 100, 'FH', 'set-b'); // the first Full House in set-b, but a low score
    const many = Array.from({ length: HALL_OF_FAME_TOP + 20 }, (_, i) => entry(`p${i}`, 1000 + i));
    const copy = { ...many[0], submittedAt: '2030-01-01T00:00:00.000Z' }; // the same pull, verified again later
    const list = hallOfFameList([early, ...many, copy]);
    expect(topPulls(list)).toHaveLength(HALL_OF_FAME_TOP);
    expect(topPulls(list)[0].id).toBe(`p${HALL_OF_FAME_TOP + 19}`);
    expect(list.map((e) => e.id)).toContain('early-fh'); // kept as a first
    expect(list.map((e) => e.id)).toContain('p0'); // the first Full House in set-a, though not top 100
    expect(list.filter((e) => e.id === 'p0')).toHaveLength(1);
    expect(list.find((e) => e.id === 'p0')?.submittedAt).toBe(many[0].submittedAt); // earliest keeps the credit
    expect(list).toHaveLength(HALL_OF_FAME_TOP + 2); // plus the two firsts outside the top
    expect(firstPulls(list).map((e) => e.id).sort()).toEqual(['early-fh', 'p0']);
  });

  it('says whether a new pull would join', () => {
    const full = Array.from({ length: HALL_OF_FAME_TOP }, (_, i) => entry(`p${i}`, 1000 + i));
    expect(wouldJoinHallOfFame({ id: 'x', setId: 'set-a', score: score(500) }, full.slice(0, 10))).toBe(true); // room
    expect(wouldJoinHallOfFame({ id: 'x', setId: 'set-a', score: score(1001) }, full)).toBe(true); // beats the lowest
    expect(wouldJoinHallOfFame({ id: 'x', setId: 'set-a', score: score(1000) }, full)).toBe(false); // a tie goes to the earlier one
    expect(wouldJoinHallOfFame({ id: 'x', setId: 'set-b', score: score(10) }, full)).toBe(true); // first Full House in set-b
    expect(wouldJoinHallOfFame({ id: 'x', setId: 'set-a', score: score(10, 'FOUR') }, full)).toBe(true); // first 4 of a Kind in set-a
    expect(wouldJoinHallOfFame({ id: 'p5', setId: 'set-a', score: score(5000) }, full)).toBe(false); // already in
    expect(wouldJoinHallOfFame({ id: 'x', setId: 'set-a', score: score(900, 'PAIR') }, full.slice(0, 3))).toBe(false); // doesn't qualify
  });
});

describe('daily board (UTC)', () => {
  const at = (id: string, score: number, submittedAt: string, hand: keyof typeof HANDS = 'FH'): RankableEntry => ({ ...entry(id, score, hand), submittedAt });

  it('reads the UTC day of a time, whatever its offset', () => {
    expect(utcDay('2026-10-15T23:59:59.999Z')).toBe('2026-10-15');
    expect(utcDay('2026-10-16T00:00:00.000Z')).toBe('2026-10-16');
    expect(utcDay('2026-10-16T01:00:00.000+02:00')).toBe('2026-10-15'); // 23:00 UTC
    expect(utcDay('not a time')).toBe('');
    expect(previousUtcDay('2026-10-16')).toBe('2026-10-15');
    expect(previousUtcDay('2026-03-01')).toBe('2026-02-28');
    expect(previousUtcDay('2027-01-01')).toBe('2026-12-31');
    expect(previousUtcDay('nope')).toBe('');
  });

  it('keeps only pulls verified on that UTC day, split at 00:00Z', () => {
    const late = at('late', 900, '2026-10-15T23:59:59.999Z');
    const early = at('early', 100, '2026-10-16T00:00:00.000Z');
    expect(dailyPulls([late, early], '2026-10-16').map((e) => e.id)).toEqual(['early']);
    expect(dailyPulls([late, early], '2026-10-15').map((e) => e.id)).toEqual(['late']);
    expect(dailyPulls([late, early], '2026-10-17')).toEqual([]);
  });

  it('ranks by score, ties to the earlier one, each pull once with its earliest verification', () => {
    const a = at('a', 500, '2026-10-16T09:00:00.000Z');
    const b = at('b', 500, '2026-10-16T08:00:00.000Z'); // same score, earlier: ranks first
    const c = at('c', 700, '2026-10-16T10:00:00.000Z');
    const cAgain = { ...c, submittedAt: '2026-10-16T11:00:00.000Z' }; // the same pull verified again
    const old = at('old', 9999, '2026-10-15T22:00:00.000Z');
    const oldAgain = { ...old, submittedAt: '2026-10-16T12:00:00.000Z' }; // first verified yesterday: not today's
    const today = dailyPulls([a, cAgain, oldAgain, b, c, old], '2026-10-16');
    expect(today.map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect(today[0].submittedAt).toBe(c.submittedAt);
    expect(dailyPulls([oldAgain, old], '2026-10-15').map((e) => e.id)).toEqual(['old']);
  });

  it(`keeps the best ${HALL_OF_FAME_DAILY_TOP}`, () => {
    const day = Array.from({ length: HALL_OF_FAME_DAILY_TOP + 10 }, (_, i) => at(`d${i}`, 100 + i, `2026-10-16T00:${String(i).padStart(2, '0')}:00.000Z`));
    const today = dailyPulls(day, '2026-10-16');
    expect(today).toHaveLength(HALL_OF_FAME_DAILY_TOP);
    expect(today[0].id).toBe(`d${HALL_OF_FAME_DAILY_TOP + 9}`);
    expect(today[today.length - 1].id).toBe('d10');
  });

  it('ranks pending entries with filed ones, and a filed pull keeps its credit over a pending copy', () => {
    type Row = RankableEntry & { pending?: boolean };
    const filed: Row = at('filed', 300, '2026-10-16T01:00:00.000Z');
    const pending: Row = { ...at('pending', 400, '2026-10-16T05:00:00.000Z'), pending: true };
    const copy: Row = { ...filed, submittedAt: '2026-10-16T06:00:00.000Z', pending: true };
    const today = dailyPulls<Row>([copy, filed, pending], '2026-10-16');
    expect(today.map((e) => [e.id, !!e.pending])).toEqual([
      ['pending', true],
      ['filed', false],
    ]);
  });

  it("adds each day's top to the published list without changing its top pulls, firsts or intake", () => {
    const top = Array.from({ length: HALL_OF_FAME_TOP + 20 }, (_, i) => entry(`p${i}`, 1000 + i)); // Oct 1
    const day = (d: string, n: number) => Array.from({ length: n }, (_, i) => at(`${d}-${i}`, 10 + i, `${d}T12:00:${String(i).padStart(2, '0')}.000Z`));
    const all = [...top, ...day('2026-10-14', 3), ...day('2026-10-15', 5), ...day('2026-10-16', 7)];
    const plain = hallOfFameList(all);
    const list = hallOfFameList(all, ['2026-10-16', '2026-10-15']);
    expect(list.slice(0, plain.length)).toEqual(plain);
    expect(list.slice(plain.length).map((e) => e.id).sort()).toEqual([...day('2026-10-15', 5), ...day('2026-10-16', 7)].map((e) => e.id).sort());
    expect(topPulls(list)).toEqual(topPulls(plain));
    expect(firstPulls(list)).toEqual(firstPulls(plain));
    expect(dailyPulls(list, '2026-10-16')).toEqual(dailyPulls(all, '2026-10-16'));
    for (const pull of [
      { id: 'x', setId: 'set-a', score: score(1050) },
      { id: 'x', setId: 'set-a', score: score(20) },
      { id: 'x', setId: 'set-b', score: score(20) },
    ])
      expect(wouldJoinHallOfFame(pull, list)).toBe(wouldJoinHallOfFame(pull, plain));
  });
});
