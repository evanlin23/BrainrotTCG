import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archivedPull, rankingsFile, serializeDailyArchive, type ArchivedPull, type DailyArchive } from '../engine';
import { parsePastMonth, parsePublishedRankings, type PublishedRankings } from './publishedRankings';

/** An archived pull received at `submittedAt`. */
const pull = (n: number, score: number, submittedAt: string): ArchivedPull =>
  archivedPull({ id: `pull-${n}`, issue: n, setId: 'og', hand: 'Full House', score, name: `Player ${n}`, submittedAt });

/** rankings.json as the build writes it, built at `generatedAt`, listing `archive`. */
const indexText = (generatedAt: string, archive: string[]) =>
  JSON.stringify(rankingsFile([], { generatedAt, days: [], archive }), null, 1) + '\n';

/** October 2026: closed days 1 and 14, and 15 and 16, which a build on the 16th still holds open. */
const october: DailyArchive = {
  schemaVersion: 1,
  month: '2026-10',
  days: {
    '2026-10-01': [pull(1, 900, '2026-10-01T09:00:00Z')],
    '2026-10-14': [pull(2, 800, '2026-10-14T23:59:00Z'), pull(3, 700, '2026-10-14T01:00:00Z')],
    '2026-10-15': [pull(4, 600, '2026-10-15T12:00:00Z')],
    '2026-10-16': [pull(5, 500, '2026-10-16T08:00:00Z')],
  },
};
const OCTOBER = serializeDailyArchive(october);
const BUILT = '2026-10-16T12:00:00.000Z';
const RANKINGS: PublishedRankings = { generatedAt: BUILT, openFrom: '2026-10-15', months: ['2026-10', '2026-09'] };

describe('parsePublishedRankings', () => {
  it("reads the build's own time and the months that can hold a closed day, newest first", () => {
    expect(parsePublishedRankings(indexText(BUILT, ['2026-09', '2026-10']))).toEqual(RANKINGS);
    // On the 2nd of a month its first day is still open, so that month has nothing closed yet.
    expect(parsePublishedRankings(indexText('2026-11-02T00:30:00Z', ['2026-10', '2026-11']))).toEqual({
      generatedAt: '2026-11-02T00:30:00Z',
      openFrom: '2026-11-01',
      months: ['2026-10'],
    });
    expect(parsePublishedRankings(indexText('2026-11-03T00:00:00Z', ['2026-10', '2026-11']))?.months).toEqual(['2026-11', '2026-10']);
    expect(parsePublishedRankings(indexText(BUILT, []))?.months).toEqual([]);
  });

  it('is null for anything that is not a rankings file this code reads', () => {
    const good = JSON.parse(indexText(BUILT, ['2026-10'])) as Record<string, unknown>;
    const variants: string[] = [
      '',
      '<!doctype html><title>Brainrot TCG</title>',
      'null',
      '[]',
      JSON.stringify({ ...good, schemaVersion: 2 }),
      JSON.stringify({ ...good, generatedAt: 'yesterday' }),
      JSON.stringify({ ...good, generatedAt: '2026-10-16T12:00:00+01:00' }),
      JSON.stringify({ ...good, archive: ['2026-10', '2026-09'] }),
      JSON.stringify({ ...good, archive: ['2026-10', '2026-10'] }),
      JSON.stringify({ ...good, archive: ['2026-13'] }),
      JSON.stringify({ ...good, extra: true }),
      JSON.stringify((({ archive: _, ...rest }) => rest)(good)),
    ];
    for (const text of variants) expect(parsePublishedRankings(text), text).toBeNull();
  });
});

describe('parsePastMonth', () => {
  it("lists a month's closed days, newest first, each as archived, and leaves out the days still open", () => {
    expect(parsePastMonth(OCTOBER, '2026-10', RANKINGS)).toEqual([
      { day: '2026-10-14', entries: october.days['2026-10-14'] },
      { day: '2026-10-01', entries: october.days['2026-10-01'] },
    ]);
    // A day before is still open a day later, then closes.
    expect(parsePastMonth(OCTOBER, '2026-10', { ...RANKINGS, openFrom: '2026-10-16' })?.map((d) => d.day)).toEqual(['2026-10-15', '2026-10-14', '2026-10-01']);
    expect(parsePastMonth(OCTOBER, '2026-10', { ...RANKINGS, openFrom: '2026-10-02' })?.map((d) => d.day)).toEqual(['2026-10-01']);
  });

  it('is null for a month rankings.json does not list', () => {
    expect(parsePastMonth(OCTOBER, '2026-10', { ...RANKINGS, months: ['2026-09'] })).toBeNull();
  });

  it('is null for an archive that fails its strict check: schema, month, cut, order or written form', () => {
    const doc = JSON.parse(OCTOBER) as { schemaVersion: number; month: string; days: Record<string, ArchivedPull[]> };
    const write = (d: unknown) => JSON.stringify(d, null, 1) + '\n';
    const eleven = Array.from({ length: 11 }, (_, i) => pull(10 + i, 1000 - i, '2026-10-01T09:00:00Z'));
    const variants: string[] = [
      '',
      '<!doctype html><title>Brainrot TCG</title>',
      write({ ...doc, schemaVersion: 2 }),
      write({ ...doc, month: '2026-09' }),
      write({ ...doc, days: { ...doc.days, '2026-09-30': [pull(9, 1, '2026-09-30T00:00:00Z')] } }),
      // More than the board's 10 places on a day: past the certified cut.
      write({ ...doc, days: { ...doc.days, '2026-10-01': eleven } }),
      write({ ...doc, days: { ...doc.days, '2026-10-01': [] } }),
      // Out of ranking order, a pull twice, an entry received on another day, an extra field.
      write({ ...doc, days: { ...doc.days, '2026-10-14': [...doc.days['2026-10-14']].reverse() } }),
      write({ ...doc, days: { ...doc.days, '2026-10-01': [doc.days['2026-10-01'][0], doc.days['2026-10-01'][0]] } }),
      write({ ...doc, days: { ...doc.days, '2026-10-01': [pull(1, 900, '2026-10-02T09:00:00Z')] } }),
      write({ ...doc, days: { ...doc.days, '2026-10-01': [{ ...doc.days['2026-10-01'][0], proof: 'x' }] } }),
      // The same data in another written form.
      JSON.stringify(doc),
      OCTOBER.trimEnd(),
    ];
    for (const text of variants) expect(parsePastMonth(text, '2026-10', RANKINGS), text.slice(0, 80)).toBeNull();
    expect(parsePastMonth(OCTOBER, '2026-10', RANKINGS)).not.toBeNull();
  });
});

describe('loading', () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  /** A fresh module each time: the loaders keep what they fetched for the visit. */
  const fresh = async () => {
    vi.resetModules();
    return import('./publishedRankings');
  };
  const ok = (text: string) => Promise.resolve(new Response(text, { status: 200 }));

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetches rankings.json once per visit, without the cached copy', async () => {
    const { loadPublishedRankings } = await fresh();
    fetchMock.mockImplementation(() => ok(indexText(BUILT, ['2026-09', '2026-10'])));
    expect(await loadPublishedRankings()).toEqual(RANKINGS);
    expect(await loadPublishedRankings()).toEqual(RANKINGS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${import.meta.env.BASE_URL}rankings.json`);
    expect(fetchMock.mock.calls[0][1]?.cache).toBe('no-cache');
  });

  it('reads a missing, unreachable or malformed rankings.json as no archive, and tries again next time', async () => {
    const { loadPublishedRankings } = await fresh();
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(new Response('Not found', { status: 404 })))
      .mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')))
      // A host that answers every path with the app's page.
      .mockImplementationOnce(() => ok('<!doctype html><title>Brainrot TCG</title>'))
      .mockImplementationOnce(() => ok(indexText(BUILT, ['2026-10'])));
    expect(await loadPublishedRankings()).toBeNull();
    expect(await loadPublishedRankings()).toBeNull();
    expect(await loadPublishedRankings()).toBeNull();
    expect((await loadPublishedRankings())?.months).toEqual(['2026-10']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fetches a listed month's archive once, and never one rankings.json doesn't list", async () => {
    const { loadPastMonth } = await fresh();
    fetchMock.mockImplementation(() => ok(OCTOBER));
    expect((await loadPastMonth(RANKINGS, '2026-10'))?.map((d) => d.day)).toEqual(['2026-10-14', '2026-10-01']);
    expect(await loadPastMonth(RANKINGS, '2026-10')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${import.meta.env.BASE_URL}rankings/daily-2026-10.json`);
    expect(await loadPastMonth(RANKINGS, '2026-08')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a missing or malformed archive as no archive, and tries again next time', async () => {
    const { loadPastMonth } = await fresh();
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(new Response('Not found', { status: 404 })))
      .mockImplementationOnce(() => ok(OCTOBER.replace('"score": 700', '"score": 801')))
      .mockImplementationOnce(() => ok(OCTOBER));
    expect(await loadPastMonth(RANKINGS, '2026-10')).toBeNull();
    // Still valid JSON, but the 14th's second place now outscores its first.
    expect(await loadPastMonth(RANKINGS, '2026-10')).toBeNull();
    expect(await loadPastMonth(RANKINGS, '2026-10')).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
