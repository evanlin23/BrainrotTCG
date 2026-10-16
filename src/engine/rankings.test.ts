import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from './bytes';
import { HALL_OF_FAME_MIN_SCORE, HALL_OF_FAME_TOP, topPulls, type RankableEntry } from './hallOfFame';
import { generateKeypair } from './identity';
import { encodeProof, pullId, signProof, verifyProof } from './proof';
import {
  CARD_BOARD_SIZE,
  cardBoard,
  cardInstances,
  cardKey,
  cardVersionBoards,
  packBoard,
  packEntry,
  packEvidence,
  RANKING_SCHEMA_VERSION,
  rebuildBoard,
  receiptTime,
  selectBoard,
  type CardInstance,
  type PackEvidence,
  type RankKey,
} from './rankings';
import { cardPoints, POKER_HANDS, SCORING_ERA } from './scoring';
import { ticketPreimage } from './ticket';
import { validateSet, type Finish, type Rarity } from './types';

let clock = 0;
const tick = () => new Date(Date.UTC(2026, 9, 1) + clock++ * 60_000).toISOString();
const NOW = '2026-10-16T00:00:00.000Z';

interface CardSpec {
  cardId: string;
  rarity: Rarity;
  isHolo?: boolean;
  finish?: Finish | null;
  misprint?: boolean;
}
const c = (cardId: string, rarity: Rarity, mods: Omit<CardSpec, 'cardId' | 'rarity'> = {}): CardSpec => ({ cardId, rarity, ...mods });
/** Four plain cards that make no combo with each other. */
const filler = [c('c1', 'COMMON'), c('c2', 'COMMON'), c('u1', 'UNCOMMON'), c('r1', 'RARE')];

const pack = (
  key: string,
  cards: CardSpec[],
  { setId = 'set-a', setVersion = 1, at = tick(), proof = `proof-${key}` }: { setId?: string; setVersion?: number; at?: string; proof?: string } = {},
): PackEvidence => ({
  pullId: `${setId}@${setVersion}/${key}/1`,
  proof,
  setId,
  setVersion,
  firstReceivedAt: at,
  cards: cards.map((spec, slot) => ({ setId, slot, isHolo: false, ...spec })),
});
const ids = (entries: readonly { id: string }[]) => entries.map((e) => e.id);

describe('Best packs', () => {
  const HANDS = [POKER_HANDS.FULL_HOUSE, POKER_HANDS.FOUR_OF_A_KIND, POKER_HANDS.PAIR];
  const entry = (id: string, score: number, i = 0): RankableEntry => ({
    id,
    setId: 'set-a',
    hand: HANDS[i % 3].name,
    multiplier: HANDS[i % 3].multiplier,
    score,
    submittedAt: tick(),
  });

  it('matches topPulls: same entries, same order, same cut', () => {
    const many = Array.from({ length: HALL_OF_FAME_TOP + 30 }, (_, i) => entry(`p${i}`, 1000 + ((i * 37) % 50) * 100, i));
    const again = { ...many[5], submittedAt: '2030-01-01T00:00:00.000Z' }; // the same pull verified later
    const input = [again, ...many];
    const board = packBoard(input, { generatedAt: NOW });
    expect(ids(board.entries)).toEqual(ids(topPulls(input)));
    expect(board.entries.find((e) => e.id === 'p5')?.submittedAt).toBe(many[5].submittedAt); // earliest keeps the credit
    expect(board).toMatchObject({ scope: 'packs', capacity: HALL_OF_FAME_TOP, completeness: { status: 'complete' } });
    expect(board.sources).toEqual({ candidates: input.length, duplicates: 1, otherEra: 0, uncertain: 0 });
  });

  it('places an exact score and time tie by pull id, whatever the input order', () => {
    const at = tick();
    const a = { ...entry('set-a@1/aa/1', 500), submittedAt: at };
    const b = { ...entry('set-a@1/bb/1', 500), submittedAt: at };
    expect(ids(packBoard([b, a], { generatedAt: NOW }).entries)).toEqual([a.id, b.id]);
    expect(ids(packBoard([a, b], { generatedAt: NOW }).entries)).toEqual([a.id, b.id]);
  });

  it('compares receipt times by instant, whatever their precision', () => {
    const a = { ...entry('set-a@1/aa/1', 500), submittedAt: '2026-10-01T12:00:07.123Z' }; // a pending entry's toISOString
    const b = { ...entry('set-a@1/bb/1', 500), submittedAt: '2026-10-01T12:00:07Z' }; // a GitHub created_at, 123 ms earlier
    const board = packBoard([a, b], { generatedAt: NOW });
    expect(ids(board.entries)).toEqual([b.id, a.id]);
    expect(board.entries.map((e) => e.firstReceivedAt)).toEqual(['2026-10-01T12:00:07.000Z', '2026-10-01T12:00:07.123Z']);
    expect(() => packBoard([{ ...a, submittedAt: 'yesterday' }], { generatedAt: NOW })).toThrow(RangeError);
  });
});

describe('Best cards', () => {
  it('ranks a winning card from a losing pack, with cutoffs independent of Best packs', () => {
    const combo = pack('combo', [c('c1', 'COMMON'), c('c1', 'COMMON'), c('c1', 'COMMON'), c('c1', 'COMMON'), c('c1', 'COMMON')]);
    const both = pack('both', [c('b1', 'BRAINROT', { isHolo: true }), ...filler]); // a holo Brainrot: top of both boards
    const lonely = pack('lonely', [...filler, c('l1', 'LEGENDARY', { isHolo: true })]); // no combo, one great card
    const evidence = [combo, both, lonely];

    const packs = packBoard(evidence.map(packEntry), { generatedAt: NOW, capacity: 2 });
    expect(ids(packs.entries)).toEqual(['set-a@1/combo/1', 'set-a@1/both/1']);

    const cards = cardBoard(evidence, { generatedAt: NOW, capacity: 3 });
    expect(ids(cards.entries)).toEqual(['set-a@1/both/1#0', 'set-a@1/lonely/1#4', 'set-a@1/both/1#4']);
    expect(cards.entries.map((e) => e.score)).toEqual([20_000, 4_000, 35]); // own points, no combo multiplier
    expect(cards.entries.some((e) => e.pullId === 'set-a@1/combo/1')).toBe(false); // a 10,000x pack of commons
    expect(cards).toMatchObject({ scope: 'cards', capacity: 3, completeness: { status: 'complete' } });
  });

  it('carries each card exactly as pulled, scored only by cardPoints', () => {
    const fancy = c('e1', 'EPIC', { isHolo: true, finish: 'GOLD', misprint: true });
    const claimed = { ...pack('fancy', [...filler, fancy]), score: 1e12, points: 1e12 } as PackEvidence; // a client's claims
    const [best] = cardBoard([claimed], { generatedAt: NOW }).entries;
    expect(best).toEqual<CardInstance>({
      id: 'set-a@1/fancy/1#4',
      pullId: 'set-a@1/fancy/1',
      slot: 4,
      score: cardPoints('EPIC', true, 'GOLD', true),
      firstReceivedAt: claimed.firstReceivedAt,
      scoringEra: SCORING_ERA,
      setId: 'set-a',
      setVersion: 1,
      cardId: 'e1',
      rarity: 'EPIC',
      isHolo: true,
      finish: 'GOLD',
      misprint: true,
      proof: 'proof-fancy',
    });
  });

  it('breaks equal points by first receipt, then pull id, then the later slot', () => {
    const holoEpic = c('e1', 'EPIC', { isHolo: true });
    const late = pack('late', [holoEpic, ...filler]);
    const early = pack('early', [holoEpic, ...filler], { at: '2026-01-01T00:00:00.000Z' });
    const twins = pack('twins', [filler[0], holoEpic, filler[1], holoEpic, filler[2]], { at: late.firstReceivedAt });
    const board = cardBoard([late, twins, early], { generatedAt: NOW, capacity: 4 });
    // Identical cards in two slots are two instances; within a pack the later slot wins, as on reveal.
    expect(ids(board.entries)).toEqual(['set-a@1/early/1#0', 'set-a@1/late/1#0', 'set-a@1/twins/1#3', 'set-a@1/twins/1#1']);
    expect(ids(cardBoard([early, twins, late], { generatedAt: NOW, capacity: 4 }).entries)).toEqual(ids(board.entries));
  });

  it('compares card receipt times by instant, whatever their precision', () => {
    const holoEpic = c('e1', 'EPIC', { isHolo: true });
    const client = pack('cl', [holoEpic, ...filler], { at: '2026-10-01T12:00:07.123Z' });
    const github = pack('gh', [holoEpic, ...filler], { at: '2026-10-01T12:00:07Z' });
    const board = cardBoard([client, github], { generatedAt: NOW, capacity: 2 });
    expect(ids(board.entries)).toEqual(['set-a@1/gh/1#0', 'set-a@1/cl/1#0']);
    expect(board.entries[0].firstReceivedAt).toBe('2026-10-01T12:00:07.000Z');
    expect(() => cardBoard([{ ...client, firstReceivedAt: 'yesterday' }], { generatedAt: NOW })).toThrow(RangeError);
  });

  it('counts a pull once however often it was signed, and rejects malformed evidence', () => {
    const first = pack('dup', [c('l1', 'LEGENDARY'), ...filler], { at: '2026-02-01T00:00:00.000Z', proof: 'proof-first' });
    const resigned = { ...first, proof: 'proof-resigned', firstReceivedAt: '2026-03-01T00:00:00.000Z' };
    const board = cardBoard([resigned, first, resigned], { generatedAt: NOW });
    expect(board.entries).toHaveLength(5);
    expect(new Set(board.entries.map((e) => e.proof))).toEqual(new Set(['proof-first'])); // earliest receipt keeps the credit
    expect(board.sources).toMatchObject({ candidates: 15, duplicates: 10 });

    const doubled = { ...first, cards: [first.cards[0], first.cards[0], ...first.cards.slice(2)] }; // slot 0 twice
    expect(() => cardBoard([doubled], { generatedAt: NOW })).toThrow(/Malformed evidence/);
    const otherSet = { ...first, cards: [{ ...first.cards[0], setId: 'set-b' }, ...first.cards.slice(1)] };
    expect(() => cardBoard([otherSet], { generatedAt: NOW })).toThrow(/Malformed evidence/);
  });

  it('ranks set versions together and never mixes scoring eras', () => {
    const v1 = pack('v1', [c('l1', 'LEGENDARY'), ...filler], { setVersion: 1 });
    const v2 = pack('v2', [c('b1', 'BRAINROT'), ...filler], { setVersion: 2 });
    const board = cardBoard([v1, v2], { generatedAt: NOW, capacity: 2 });
    expect(board.entries.map((e) => [e.id, e.setVersion])).toEqual([
      ['set-a@2/v2/1#0', 2],
      ['set-a@1/v1/1#0', 1],
    ]);

    const stale: CardInstance = { ...board.entries[0], id: 'set-a@1/old/1#0', pullId: 'set-a@1/old/1', score: 1e9, scoringEra: SCORING_ERA - 1 };
    const mixed = selectBoard([...cardInstances([v1, v2]), stale], { scope: 'cards', capacity: 2, generatedAt: NOW });
    expect(mixed.entries).toEqual([]); // nothing can be certified against an unconverted score
    expect(mixed.completeness).toEqual({ status: 'partial', reason: 'scoring-changed' });
    expect(mixed.sources.otherEra).toBe(1);
  });

  it('is partial below the intake minimum, complete when the certified part fills it', () => {
    const evidence = [pack('big', [c('b1', 'BRAINROT', { isHolo: true }), ...filler]), pack('small', [c('l1', 'LEGENDARY'), ...filler])];
    const coverage = { kind: 'min-score', score: HALL_OF_FAME_MIN_SCORE } as const;
    const partial = cardBoard(evidence, { generatedAt: NOW, coverage });
    expect(ids(partial.entries)).toEqual(['set-a@1/big/1#0']); // the Legendary might be beaten by an unfiled pack
    expect(partial.completeness).toEqual({ status: 'partial', reason: 'below-intake-minimum' });
    expect(partial.sources.uncertain).toBe(9);
    expect(cardBoard(evidence, { generatedAt: NOW, capacity: 1, coverage }).completeness).toEqual({ status: 'complete' });
  });

  it('stays partial below the intake minimum when rebuilt without a new coverage', () => {
    const evidence = [pack('big', [c('b1', 'BRAINROT', { isHolo: true }), ...filler]), pack('small', [c('l1', 'LEGENDARY'), ...filler])];
    const partial = cardBoard(evidence, { generatedAt: NOW, coverage: { kind: 'min-score', score: HALL_OF_FAME_MIN_SCORE } });
    expect(rebuildBoard(partial, cardInstances(evidence), { generatedAt: NOW })).toEqual(partial);
    const everything = rebuildBoard(partial, cardInstances(evidence), { coverage: { kind: 'all' }, generatedAt: NOW });
    expect(everything).toMatchObject({ completeness: { status: 'complete' }, certifiedThrough: { kind: 'all' } });
    expect(everything.entries).toHaveLength(CARD_BOARD_SIZE);
  });

  it('records schema, era and freshness', () => {
    const a = pack('a', filler.concat(c('e1', 'EPIC')), { at: '2026-04-01T00:00:00.000Z' });
    const b = pack('b', filler.concat(c('e1', 'EPIC')), { at: '2026-05-01T00:00:00.000Z' });
    const board = cardBoard([b, a], { generatedAt: NOW });
    expect(board).toMatchObject({
      schemaVersion: RANKING_SCHEMA_VERSION,
      scope: 'cards',
      capacity: CARD_BOARD_SIZE,
      scoringEra: SCORING_ERA,
      generatedAt: NOW,
      latestReceivedAt: '2026-05-01T00:00:00.000Z',
      sources: { candidates: 10, duplicates: 0, otherEra: 0, uncertain: 0 },
    });
    expect(board.entries).toHaveLength(CARD_BOARD_SIZE);
  });
});

describe('Best versions of a card', () => {
  const holoEpic = c('e1', 'EPIC', { isHolo: true });
  const board = (boards: Map<string, { entries: CardInstance[] }>, key: string) => boards.get(key)?.entries ?? [];

  it('ranks each card on its own board, with a cutoff independent of Best packs and Best cards', () => {
    const combo = pack('combo', [c('c1', 'COMMON'), c('c1', 'COMMON'), c('c1', 'COMMON'), c('c1', 'COMMON'), c('c1', 'COMMON')]);
    const both = pack('both', [c('b1', 'BRAINROT', { isHolo: true }), ...filler]);
    const lonely = pack('lonely', [...filler, c('l1', 'LEGENDARY', { isHolo: true })]);
    const weak = pack('weak', [c('w1', 'COMMON'), ...filler]); // the only w1 ever pulled
    const evidence = [combo, both, lonely, weak];

    expect(ids(packBoard(evidence.map(packEntry), { generatedAt: NOW, capacity: 2 }).entries)).not.toContain(weak.pullId);
    expect(cardBoard(evidence, { generatedAt: NOW, capacity: 3 }).entries.some((e) => e.pullId === weak.pullId)).toBe(false);

    const boards = cardVersionBoards(cardInstances(evidence), { generatedAt: NOW, capacity: 2 });
    expect([...boards.keys()]).toEqual(['set-a/b1', 'set-a/c1', 'set-a/c2', 'set-a/l1', 'set-a/r1', 'set-a/u1', 'set-a/w1']);
    expect(ids(board(boards, 'set-a/w1'))).toEqual(['set-a@1/weak/1#0']);
    expect(boards.get('set-a/w1')).toMatchObject({ scope: 'card-versions', card: 'set-a/w1', capacity: 2, completeness: { status: 'complete' } });
    // Five c1 in the combo pack and more in the filler: c1's board keeps its own best two.
    expect(boards.get('set-a/c1')?.sources.candidates).toBe(5 + 3);
    expect(board(boards, 'set-a/c1').map((e) => e.score)).toEqual([cardPoints('COMMON', false, null, false), cardPoints('COMMON', false, null, false)]);
    expect(board(boards, 'set-a/c1').every((e) => e.pullId === combo.pullId)).toBe(true); // earliest receipt, later slot first
    expect(ids(board(boards, 'set-a/c1'))).toEqual(['set-a@1/combo/1#4', 'set-a@1/combo/1#3']);
  });

  it('ranks versions of one card together and keeps other sets apart', () => {
    const v1 = pack('v1', [holoEpic, ...filler], { setVersion: 1 });
    const v2 = pack('v2', [c('e1', 'EPIC', { isHolo: true, finish: 'GOLD' }), ...filler], { setVersion: 2 });
    const other = pack('b', [holoEpic, ...filler], { setId: 'set-b' });
    const boards = cardVersionBoards(cardInstances([v1, v2, other]), { generatedAt: NOW });
    expect(cardKey('set-a', 'e1')).toBe('set-a/e1');
    expect(board(boards, 'set-a/e1').map((e) => [e.id, e.setVersion])).toEqual([
      ['set-a@2/v2/1#0', 2],
      ['set-a@1/v1/1#0', 1],
    ]);
    expect(ids(board(boards, 'set-b/e1'))).toEqual(['set-b@1/b/1#0']);
    expect(boards.get('set-a/e1')?.capacity).toBe(CARD_BOARD_SIZE);
  });

  it('breaks ties by receipt, then pull id, then the later slot, whatever the input order', () => {
    const at = tick();
    const early = pack('early', [holoEpic, ...filler], { at: '2026-01-01T00:00:00.000Z' });
    const b = pack('b', [holoEpic, ...filler], { at });
    const a = pack('a', [filler[0], holoEpic, filler[1], holoEpic, filler[2]], { at });
    const instances = cardInstances([b, a, early]);
    const expected = ['set-a@1/early/1#0', 'set-a@1/a/1#3', 'set-a@1/a/1#1', 'set-a@1/b/1#0'];
    expect(ids(board(cardVersionBoards(instances, { generatedAt: NOW }), 'set-a/e1'))).toEqual(expected);
    expect(ids(board(cardVersionBoards([...instances].reverse(), { generatedAt: NOW }), 'set-a/e1'))).toEqual(expected);
  });

  it('leaves only the card with an other-era instance partial', () => {
    const instances = cardInstances([pack('p', [holoEpic, ...filler]), pack('q', [holoEpic, ...filler])]);
    const stale = instances.map((i) => (i.cardId === 'e1' && i.pullId.includes('/q/') ? { ...i, scoringEra: SCORING_ERA + 1 } : i));
    const boards = cardVersionBoards(stale, { generatedAt: NOW });
    expect(boards.get('set-a/e1')).toMatchObject({ entries: [], completeness: { status: 'partial', reason: 'scoring-changed' } });
    expect(boards.get('set-a/r1')).toMatchObject({ completeness: { status: 'complete' } });
    expect(board(boards, 'set-a/r1')).toHaveLength(2);
  });

  it('certifies a pack-score intake minimum per card, which leaves cheap cards partial', () => {
    const p = pack('p', [c('l1', 'LEGENDARY', { isHolo: true }), ...filler]);
    const boards = cardVersionBoards(cardInstances([p]), { generatedAt: NOW, coverage: { kind: 'min-score', score: 1_000 } });
    expect(ids(board(boards, 'set-a/l1'))).toEqual(['set-a@1/p/1#0']);
    expect(boards.get('set-a/c1')).toMatchObject({ entries: [], completeness: { status: 'partial', reason: 'below-intake-minimum' } });
  });

  it('refuses a through bound, which belongs to one board', () => {
    expect(() => cardVersionBoards([], { generatedAt: NOW, coverage: { kind: 'through', last: null } })).toThrow(RangeError);
  });

  it('names its card only on card-versions boards', () => {
    expect(() => selectBoard([], { scope: 'card-versions', capacity: 1, generatedAt: NOW })).toThrow(RangeError);
    expect(() => selectBoard([], { scope: 'cards', card: 'set-a/e1', capacity: 1, generatedAt: NOW })).toThrow(RangeError);
    expect(selectBoard([], { scope: 'cards', capacity: 1, generatedAt: NOW })).not.toHaveProperty('card');
  });

  it('rebuilds one card board, keeping its scope and card', () => {
    const p = pack('p', [holoEpic, ...filler]);
    const q = pack('q', [holoEpic, ...filler]);
    const instances = cardInstances([p, q]).filter((i) => i.cardId === 'e1');
    const previous = cardVersionBoards(instances, { generatedAt: NOW, capacity: 1 }).get('set-a/e1')!;
    expect(ids(previous.entries)).toEqual(['set-a@1/p/1#0']);
    const rebuilt = rebuildBoard(previous, instances, { removed: [p.pullId], coverage: { kind: 'all' }, generatedAt: NOW });
    expect(rebuilt).toMatchObject({ scope: 'card-versions', card: 'set-a/e1', completeness: { status: 'complete' } });
    expect(ids(rebuilt.entries)).toEqual(['set-a@1/q/1#0']);
  });
});

describe('Rebuilding a board', () => {
  const top = (key: string, spec: CardSpec, more: CardSpec[] = filler) => pack(key, [spec, ...more]);
  const p1 = top('p1', c('b1', 'BRAINROT', { isHolo: true })); // 20,000
  const p2 = top('p2', c('l1', 'LEGENDARY', { isHolo: true }), [c('r1', 'RARE', { isHolo: true }), ...filler.slice(0, 3)]); // 4,000, then 700
  const p3 = top('p3', c('e1', 'EPIC', { isHolo: true })); // 1,400
  const p4 = top('p4', c('b1', 'BRAINROT')); // 1,000: the true runner-up, which a winners-only cache never kept
  const all = [p1, p2, p3, p4];
  const board = cardBoard(all, { generatedAt: NOW, capacity: 3 });
  const removed = [p1.pullId];

  it('promotes the true runner-up when every candidate was kept', () => {
    expect(ids(board.entries)).toEqual(['set-a@1/p1/1#0', 'set-a@1/p2/1#0', 'set-a@1/p3/1#0']);
    const rebuilt = rebuildBoard(board, cardInstances(all), { removed, coverage: { kind: 'all' }, generatedAt: NOW });
    expect(rebuilt.entries).toEqual(cardBoard([p2, p3, p4], { generatedAt: NOW, capacity: 3 }).entries);
    expect(rebuilt.completeness).toEqual({ status: 'complete' });
  });

  it('goes partial instead of promoting a runner-up a winners-only cache never held', () => {
    const winners = cardInstances([p1, p2, p3]); // the winners' packs, all slots, re-derived from their proofs
    const rebuilt = rebuildBoard(board, winners, { removed, generatedAt: NOW });
    expect(ids(rebuilt.entries)).toEqual(['set-a@1/p2/1#0', 'set-a@1/p3/1#0']); // not p2's 700-point holo Rare
    expect(rebuilt.completeness).toEqual({ status: 'partial', reason: 'runners-up-not-retained' });
    expect(rebuildBoard(board, board.entries, { removed, generatedAt: NOW }).entries).toEqual(rebuilt.entries);

    // New evidence above the old cut is certain, so it can fill the board again.
    const p5 = top('p5', c('l1', 'LEGENDARY', { finish: 'SILVER' })); // 2,000
    const refilled = rebuildBoard(board, [...winners, ...cardInstances([p5])], { removed, generatedAt: NOW });
    expect(ids(refilled.entries)).toEqual(['set-a@1/p2/1#0', 'set-a@1/p5/1#0', 'set-a@1/p3/1#0']);
    expect(refilled.completeness).toEqual({ status: 'complete' });
  });

  it('keeps the certified bound when every entry is removed', () => {
    expect(board.certifiedThrough).toEqual({ kind: 'through', last: expect.objectContaining({ id: 'set-a@1/p3/1#0', score: 1_400 }) });
    const gone = [p1.pullId, p2.pullId, p3.pullId];
    const emptied = rebuildBoard(board, cardInstances([p1, p2, p3]), { removed: gone, generatedAt: NOW });
    expect(emptied).toMatchObject({ entries: [], completeness: { status: 'partial', reason: 'runners-up-not-retained' } });
    expect(emptied.certifiedThrough).toEqual(board.certifiedThrough);

    // Later evidence above the old cut is certified again; the true runner-up (p4) still can't be.
    const p5 = top('p5', c('l1', 'LEGENDARY', { finish: 'SILVER' })); // 2,000
    const p6 = top('p6', c('r1', 'RARE')); // 35, below the cut
    const refilled = rebuildBoard(emptied, cardInstances([p5, p6]), { generatedAt: NOW });
    expect(ids(refilled.entries)).toEqual(['set-a@1/p5/1#0']);
    expect(refilled).toMatchObject({ completeness: { status: 'partial', reason: 'runners-up-not-retained' }, sources: { uncertain: 9 } });
  });

  it('keeps a board that held everything complete after a removal', () => {
    const roomy = cardBoard([p1], { generatedAt: NOW });
    const rebuilt = rebuildBoard(roomy, roomy.entries, { generatedAt: NOW });
    expect(rebuilt).toEqual(roomy);
    const emptied = rebuildBoard(roomy, roomy.entries, { removed, generatedAt: NOW });
    expect(emptied).toMatchObject({ entries: [], completeness: { status: 'complete' } });
  });

  it('certifies nothing after a scoring-era change until the proofs are re-derived', () => {
    const old = { ...board, scoringEra: SCORING_ERA - 1, entries: board.entries.map((e) => ({ ...e, scoringEra: SCORING_ERA - 1 })) };
    const stale = rebuildBoard(old, old.entries, { generatedAt: NOW });
    expect(stale).toMatchObject({ entries: [], scoringEra: SCORING_ERA, completeness: { status: 'partial', reason: 'scoring-changed' } });
    expect(rebuildBoard(old, cardInstances([p1, p2, p3]), { generatedAt: NOW }).entries).toEqual([]);
    const rederived = rebuildBoard(old, cardInstances(all), { coverage: { kind: 'all' }, generatedAt: NOW });
    expect(rederived).toMatchObject({ entries: board.entries, completeness: { status: 'complete' } });
  });
});

describe('Evidence from a signed proof', () => {
  const set = validateSet({
    id: 'set-a',
    version: 1,
    name: 'Set A',
    era: 'test',
    releasedAt: '2026-10-12',
    packSize: 5,
    odds: { COMMON: 5000, UNCOMMON: 2500, RARE: 1500, EPIC: 700, LEGENDARY: 250, BRAINROT: 50 },
    holoOdds: 500,
    cards: [
      { id: 'c1', name: 'C1', rarity: 'COMMON' },
      { id: 'u1', name: 'U1', rarity: 'UNCOMMON' },
      { id: 'r1', name: 'R1', rarity: 'RARE' },
      { id: 'e1', name: 'E1', rarity: 'EPIC' },
      { id: 'l1', name: 'L1', rarity: 'LEGENDARY' },
      { id: 'b1', name: 'B1', rarity: 'BRAINROT' },
    ],
  });
  const lookup = (id: string, version: number) => (id === set.id && version === set.version ? set : undefined);
  /** Argon2 is slow and covered elsewhere; any deterministic ticket works here. */
  const fastTicket = async (setKey: string, publicKey: Uint8Array, nonce: number) => sha256(utf8(ticketPreimage(setKey, publicKey, nonce)));

  it('feeds both boards from one verified proof, once per pull however it was signed', async () => {
    const keys = generateKeypair();
    const unsigned = { setId: 'set-a', setVersion: 1, publicKey: keys.publicKey, nonce: 7 };
    const proofA = encodeProof(signProof({ ...unsigned, name: 'Ann' }, keys.secretKey));
    const proofB = encodeProof(signProof({ ...unsigned, name: 'Ann B' }, keys.secretKey)); // the same pull, signed again
    const pull = await verifyProof(proofA, lookup, fastTicket);
    const evidence = [packEvidence(pull, proofA, '2026-06-01T00:00:00.000Z'), packEvidence(await verifyProof(proofB, lookup, fastTicket), proofB, '2026-06-02T00:00:00.000Z')];

    expect(packEntry(evidence[0])).toMatchObject({ id: pullId(pull.proof), score: pull.score.score, hand: pull.score.hand.name, proof: proofA });
    const cards = cardBoard(evidence, { generatedAt: NOW });
    expect(cards.entries).toHaveLength(set.packSize);
    expect(cards.sources.duplicates).toBe(set.packSize);
    for (const e of cards.entries) {
      const pulled = pull.cards[e.slot];
      expect(e).toMatchObject({ id: `${pullId(pull.proof)}#${e.slot}`, cardId: pulled.cardId, proof: proofA });
      expect(e.score).toBe(cardPoints(pulled.rarity, pulled.isHolo, pulled.finish, pulled.misprint));
    }
  });
});

describe('Receipt times', () => {
  it('takes only an ISO 8601 UTC time ending in Z, with or without milliseconds', () => {
    expect(receiptTime('2026-10-01T12:00:07Z')).toBe('2026-10-01T12:00:07.000Z');
    expect(receiptTime('2026-10-01T12:00:07.123Z')).toBe('2026-10-01T12:00:07.123Z');
    expect(receiptTime('2028-02-29T23:59:59.999Z')).toBe('2028-02-29T23:59:59.999Z');
    for (const t of [
      'yesterday',
      'Thu Oct 01 2026 12:00:07 GMT+0000',
      '2026-10-01',
      '2026-10-01T12:00:07',
      '2026-10-01T12:00Z',
      '2026-10-01 12:00:07Z',
      '2026-10-01T12:00:07+00:00',
      '2026-10-01T12:00:07.12Z',
      '2026-10-01T12:00:07.1234Z',
      '2026-10-01t12:00:07z',
      '+002026-10-01T12:00:07.000Z',
      '2026-02-30T00:00:00Z',
      '2026-10-01T24:00:00Z',
      '2026-10-01T12:60:00Z',
      ' 2026-10-01T12:00:07Z',
    ]) {
      expect(() => receiptTime(t), t).toThrow(RangeError);
    }
  });

  type Tagged = RankKey & { tag: string };
  const key = (id: string, firstReceivedAt: string, tag = id): Tagged => ({ id, pullId: id, score: 100, firstReceivedAt, scoringEra: SCORING_ERA, tag });
  // Plain strings would put "…07.100Z" before "…07Z", 100 ms earlier.
  const a = key('a', '2026-10-01T12:00:07.100Z');
  const b = key('b', '2026-10-01T12:00:07Z');
  const c = key('c', '2026-10-01T12:00:06.900Z');

  it('are compared by instant when a board is selected, whatever form the candidates carry', () => {
    const later = key('b', '2026-10-01T12:00:07.050Z', 'b-later');
    const same = key('b', '2026-10-01T12:00:07.000Z', 'b-same');
    const board = selectBoard([a, later, b, same, c], { scope: 'packs', capacity: 5, generatedAt: NOW });
    expect(board.entries.map((e) => [e.id, e.firstReceivedAt, e.tag])).toEqual([
      ['c', '2026-10-01T12:00:06.900Z', 'c'],
      // b's earliest receipt, and the first given of two at that instant.
      ['b', '2026-10-01T12:00:07.000Z', 'b'],
      ['a', '2026-10-01T12:00:07.100Z', 'a'],
    ]);
    expect(board.latestReceivedAt).toBe('2026-10-01T12:00:07.100Z');
    expect(board.sources).toEqual({ candidates: 5, duplicates: 2, otherEra: 0, uncertain: 0 });
    expect(() => selectBoard([key('x', '2026-10-01 12:00:07Z')], { scope: 'packs', capacity: 1, generatedAt: NOW })).toThrow(RangeError);
  });

  it('are compared by instant against a coverage bound, in selectBoard and rebuildBoard', () => {
    // Everything at or above b is known; a, 100 ms after b on the same score, is not.
    const bound = { kind: 'through', last: b } as const;
    const board = selectBoard([a, b, c], { scope: 'packs', capacity: 5, generatedAt: NOW, coverage: bound });
    expect(ids(board.entries)).toEqual(['c', 'b']);
    expect(board.sources.uncertain).toBe(1);
    expect(board.completeness).toEqual({ status: 'partial', reason: 'runners-up-not-retained' });
    expect(board.certifiedThrough).toEqual({ kind: 'through', last: { ...b, firstReceivedAt: '2026-10-01T12:00:07.000Z' } });

    // A previous board whose bound carries GitHub's form rebuilds the same way.
    const previous = { ...board, certifiedThrough: bound };
    const rebuilt = rebuildBoard(previous, [a, b, c], { generatedAt: NOW });
    expect(ids(rebuilt.entries)).toEqual(['c', 'b']);
    expect(rebuilt.sources.uncertain).toBe(1);
    expect(() => rebuildBoard(previous, [a, b, c], { generatedAt: NOW, coverage: { kind: 'through', last: key('b', 'soon') } })).toThrow(RangeError);
  });
});
