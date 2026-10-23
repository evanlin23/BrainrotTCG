import { describe, expect, it } from 'vitest';
import { HALL_OF_FAME_DAILY_TOP, HALL_OF_FAME_TOP } from './hallOfFame';
import {
  DAILY_ARCHIVE_VERSION,
  mergeDailyArchive,
  parseDailyArchive,
  parseRankingsFile,
  RANKINGS_BOARD_SIZE,
  RANKINGS_FILE_VERSION,
  rankingsFile,
  serializeDailyArchive,
  type ArchivedPull,
  type DailyArchive,
  type PublishedPull,
} from './rankingsArchive';
import { SCORING_ERA } from './scoring';

const NOW = '2026-10-16T12:00:00.000Z';

const pull = (n: number, score: number, submittedAt: string, extra: Partial<PublishedPull> = {}): PublishedPull => ({
  id: `lockdown-lore@1/${String(n).padStart(4, '0')}`,
  setId: 'lockdown-lore',
  hand: 'Pair',
  multiplier: 2,
  score,
  submittedAt,
  issue: n,
  name: `player ${n}`,
  ...extra,
});
const archived = ({ id, issue, setId, hand, score, name, submittedAt, receipt }: PublishedPull): ArchivedPull => ({
  id,
  issue,
  setId,
  hand,
  score,
  name,
  submittedAt,
  ...(receipt ? { receipt } : {}),
});
/** n pulls received on `day`, best first. */
const dayOf = (day: string, n: number, from = 1): PublishedPull[] =>
  Array.from({ length: n }, (_, i) => pull(from + i, 10_000 - i, `${day}T0${i % 10}:00:00Z`));
const archive = (days: Record<string, ArchivedPull[]>, month = '2026-10'): DailyArchive => ({ schemaVersion: DAILY_ARCHIVE_VERSION, month, days });

describe('rankingsFile', () => {
  it('ranks the top of the published list and of each day, without proofs', () => {
    const today = dayOf('2026-10-16', 12);
    const yesterday = dayOf('2026-10-15', 3, 100).map((e) => ({ ...e, score: e.score + 50_000, receipt: 'verification' as const, proof: 'x' }));
    const file = rankingsFile([...today, ...yesterday], { generatedAt: NOW, days: ['2026-10-16', '2026-10-15'], archive: ['2026-09'] });
    expect(file).toMatchObject({ schemaVersion: RANKINGS_FILE_VERSION, generatedAt: NOW, archive: ['2026-09'] });
    expect(file.allTime.entries.map((e) => e.issue)).toEqual([100, 101, 102, 1, 2, 3, 4, 5, 6, 7]);
    expect(file.days.map((d) => [d.day, d.board.entries.map((e) => e.issue)])).toEqual([
      ['2026-10-16', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
      ['2026-10-15', [100, 101, 102]],
    ]);
    expect(file.days[1].board.entries[0]).toEqual(archived(yesterday[0]));
    expect(Object.keys(file.days[1].board.entries[0])).toEqual(['id', 'issue', 'setId', 'hand', 'score', 'name', 'submittedAt', 'receipt']);
    for (const b of [file.allTime, ...file.days.map((d) => d.board)]) {
      expect(b).toMatchObject({ scope: 'packs', capacity: RANKINGS_BOARD_SIZE, scoringEra: SCORING_ERA, completeness: { status: 'complete' } });
    }
    // Fewer than the list keeps, so the list holds every one there is.
    expect(file.days[1].board.certifiedThrough).toEqual({ kind: 'all' });
  });

  it('fills each board from a full top, and certifies it through its own last place', () => {
    const many = dayOf('2026-10-16', HALL_OF_FAME_TOP + 5).map((e, i) => ({ ...e, submittedAt: `2026-10-16T${String(i % 24).padStart(2, '0')}:00:00Z` }));
    const file = rankingsFile(many, { generatedAt: NOW, days: ['2026-10-16'], archive: [] });
    for (const b of [file.allTime, file.days[0].board]) {
      expect(b.entries.map((e) => e.issue)).toEqual(many.slice(0, RANKINGS_BOARD_SIZE).map((e) => e.issue));
      expect(b.completeness).toEqual({ status: 'complete' });
      expect(b.certifiedThrough).toEqual({ kind: 'through', last: expect.objectContaining({ id: many[RANKINGS_BOARD_SIZE - 1].id }) });
      expect(b.sources).toMatchObject({ uncertain: 0 });
    }
    expect(file.allTime.sources.candidates).toBe(HALL_OF_FAME_TOP);
    expect(file.days[0].board.sources.candidates).toBe(HALL_OF_FAME_DAILY_TOP);
  });
});

describe('daily archives', () => {
  const oct3 = dayOf('2026-10-03', 3).map(archived);
  const oct4 = [archived(pull(9, 500, '2026-10-04T23:59:59.999Z', { receipt: 'verification' }))];
  const text = serializeDailyArchive(archive({ '2026-10-04': oct4, '2026-10-03': oct3 }));

  it('reads back exactly what it writes', () => {
    expect(Object.keys(JSON.parse(text).days)).toEqual(['2026-10-03', '2026-10-04']);
    const parsed = parseDailyArchive(text, '2026-10');
    expect(parsed.days).toEqual({ '2026-10-03': oct3, '2026-10-04': oct4 });
    expect(serializeDailyArchive(parsed)).toBe(text);
  });

  const edit = (change: (data: { schemaVersion: unknown; month: unknown; days: Record<string, unknown[]> } & Record<string, unknown>) => void, indent = 1) => {
    const data = JSON.parse(text);
    change(data);
    return JSON.stringify(data, null, indent) + '\n';
  };
  const entry = (patch: Record<string, unknown>) => (d: { days: Record<string, unknown[]> }) => {
    d.days['2026-10-03'][0] = { ...(d.days['2026-10-03'][0] as object), ...patch };
  };
  it.each([
    ['not JSON', text.slice(0, -3)],
    ['another top-level field', edit((d) => (d.extra = 1))],
    ['another schema version', edit((d) => (d.schemaVersion = 2))],
    ['another month', edit((d) => (d.month = '2026-09'))],
    ['a day of another month', edit((d) => (d.days['2026-09-30'] = d.days['2026-10-03']))],
    ["a day that doesn't exist", edit((d) => (d.days['2026-10-32'] = d.days['2026-10-03']))],
    ['an empty day', edit((d) => (d.days['2026-10-03'] = []))],
    ['a day over the board size', edit((d) => (d.days['2026-10-03'] = dayOf('2026-10-03', RANKINGS_BOARD_SIZE + 1).map(archived)))],
    ['an extra entry field', edit(entry({ proof: 'x' }))],
    ['a missing entry field', edit(entry({ name: undefined }))],
    ['a null receipt', edit(entry({ receipt: null }))],
    ['another receipt kind', edit(entry({ receipt: 'guess' }))],
    ["an issue that isn't a number", edit(entry({ issue: '1' }))],
    ["a score that isn't an integer", edit(entry({ score: 1.5 }))],
    ["a time that isn't a receipt time", edit(entry({ submittedAt: '2026-10-03' }))],
    ['an entry received on another day', edit(entry({ submittedAt: '2026-10-02T00:00:00Z' }))],
    ['entries out of order', edit((d) => d.days['2026-10-03'].reverse())],
    ['a pull twice', edit((d) => (d.days['2026-10-03'][1] = { ...(d.days['2026-10-03'][1] as object), id: oct3[0].id }))],
    ['days out of order', edit((d) => (d.days = { '2026-10-04': d.days['2026-10-04'], '2026-10-03': d.days['2026-10-03'] }))],
    ['another layout', edit(() => {}, 2)],
    ['no final newline', text.trimEnd()],
  ])('refuses an archive with %s', (_, bad) => {
    expect(() => parseDailyArchive(bad, '2026-10')).toThrow(/^The daily archive for 2026-10 /);
  });

  it('refuses a well-formed archive read as another month', () => {
    expect(() => parseDailyArchive(text, '2026-11')).toThrow('names month 2026-10');
  });

  it('rebuilds the open days and copies every other day, less what was removed, without refilling it', () => {
    const previous = parseDailyArchive(text, '2026-10');
    const oct4Now = dayOf('2026-10-04', 2, 50).map(archived);
    const removed = new Set([oct3[1].issue]);
    const merged = mergeDailyArchive(previous, '2026-10', { '2026-10-04': oct4Now, '2026-11-01': dayOf('2026-11-01', 1).map(archived) }, (e) => !removed.has(e.issue));
    expect(merged).toEqual(archive({ '2026-10-03': [oct3[0], oct3[2]], '2026-10-04': oct4Now }));
    // An untouched day keeps its bytes.
    const unchanged = serializeDailyArchive(mergeDailyArchive(previous, '2026-10', {}, () => true)!);
    expect(unchanged).toBe(text);
  });

  it('drops a day left empty, and the month when no day is left', () => {
    const previous = parseDailyArchive(text, '2026-10');
    expect(mergeDailyArchive(previous, '2026-10', {}, (e) => e.issue !== 9)?.days).toEqual({ '2026-10-03': oct3 });
    expect(mergeDailyArchive(previous, '2026-10', { '2026-10-03': [] }, (e) => e.issue === 1)).toBeNull();
    expect(mergeDailyArchive(null, '2026-10', {}, () => true)).toBeNull();
    expect(() => mergeDailyArchive(previous, '2026-11', {}, () => true)).toThrow(RangeError);
  });
});

describe('parseRankingsFile', () => {
  const file = rankingsFile([], { generatedAt: NOW, days: ['2026-10-16'], archive: ['2026-09', '2026-10'] });
  const text = JSON.stringify(file);

  it('lists the archive months', () => {
    expect(parseRankingsFile(text)).toEqual(['2026-09', '2026-10']);
  });

  it.each([
    ['not JSON', '{'],
    ['a list', '[]'],
    ['another field', JSON.stringify({ ...file, extra: 1 })],
    ['a missing field', JSON.stringify({ ...file, archive: undefined })],
    ['another schema version', JSON.stringify({ ...file, schemaVersion: 2 })],
    ["a time that isn't a receipt time", JSON.stringify({ ...file, generatedAt: 'now' })],
    ['months out of order', JSON.stringify({ ...file, archive: ['2026-10', '2026-09'] })],
    ['a month twice', JSON.stringify({ ...file, archive: ['2026-10', '2026-10'] })],
    ["a month that doesn't exist", JSON.stringify({ ...file, archive: ['2026-13'] })],
  ])('refuses a file with %s', (_, bad) => {
    expect(() => parseRankingsFile(bad)).toThrow(/^The deployed rankings\.json /);
  });
});
