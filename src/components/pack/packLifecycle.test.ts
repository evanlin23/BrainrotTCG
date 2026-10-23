import { describe, expect, it } from 'vitest';
import type { OpenedPack } from '../../game/pulls';
import { SEALED, transition, type PackEvent, type PackStage } from './packLifecycle';

/** Plays events from a stage; returns where it ended and how many times a pack was recorded. */
const play = (events: PackEvent[], from: PackStage = SEALED) =>
  events.reduce(
    (state, event) => {
      const step = transition(state.stage, event);
      return { stage: step.stage, records: state.records + (step.record ? 1 : 0) };
    },
    { stage: from, records: 0 },
  );

/** Only identity matters here: the lifecycle carries the pack, it never looks inside. */
const PACK = { nonce: 3 } as OpenedPack;
const landed: PackEvent = { type: 'landed', pack: PACK };
const REVEALING: PackStage = { kind: 'revealing', pack: PACK };

const WAITING: PackStage = { kind: 'waiting', leaving: false };

describe('the pack lifecycle', () => {
  it('goes sealed, torn, waiting, revealing, summary and back, recording when the reveal ends', () => {
    const toReveal = play([{ type: 'tear' }, { type: 'spend', blocked: false }, landed]);
    expect(toReveal).toEqual({ stage: REVEALING, records: 0 });
    expect(play([{ type: 'finish' }], toReveal.stage)).toEqual({ stage: { kind: 'summary' }, records: 1 });
    expect(play([{ type: 'finish' }, { type: 'close' }], toReveal.stage)).toEqual({ stage: SEALED, records: 1 });
  });

  it('hands over the pack it was dealt, from the stage, whichever way the reveal ends', () => {
    for (const end of [{ type: 'finish' }, { type: 'leave' }, { type: 'unmount' }] as PackEvent[]) {
      expect(transition(transition(SEALED, { type: 'tear' }).stage, end).record).toBeNull();
      expect(transition(REVEALING, end).record).toBe(PACK);
    }
  });

  it('records a pack once however the reveal ends', () => {
    const revealing = REVEALING;
    for (const ends of [
      [{ type: 'leave' }, { type: 'leave' }],
      [{ type: 'finish' }, { type: 'leave' }],
      [{ type: 'finish' }, { type: 'finish' }, { type: 'unmount' }],
      [{ type: 'leave' }, { type: 'unmount' }],
      [{ type: 'unmount' }, { type: 'leave' }, { type: 'finish' }],
    ] as PackEvent[][]) {
      expect(play(ends, revealing).records).toBe(1);
    }
  });

  it('puts a pack left before its ticket is spent back sealed, spending nothing', () => {
    expect(play([{ type: 'leave' }, { type: 'spend', blocked: false }], { kind: 'tearing' })).toEqual({ stage: SEALED, records: 0 });
  });

  it('keeps a pack left while its ticket is on its way, once, when the ticket lands', () => {
    const left = play([{ type: 'leave' }, { type: 'leave' }], WAITING);
    expect(left).toEqual({ stage: { kind: 'waiting', leaving: 'left' }, records: 0 });
    const first = transition(left.stage, landed);
    expect(first).toMatchObject({ stage: SEALED, record: PACK });
    expect(first.from).toEqual({ kind: 'waiting', leaving: 'left' });
    // A second arrival has nothing to land on.
    expect(play([landed], first.stage).records).toBe(0);
  });

  it('keeps a pack whose opener unmounted while the ticket was on its way, and does not call that leaving', () => {
    const gone = play([{ type: 'unmount' }, { type: 'unmount' }, { type: 'leave' }], WAITING);
    expect(gone).toEqual({ stage: { kind: 'waiting', leaving: 'unmounted' }, records: 0 });
    expect(transition(gone.stage, landed)).toMatchObject({ stage: SEALED, record: PACK });
  });

  it('leaves a player who left on the packs screen when the ticket fails, and tells a player who stayed', () => {
    expect(play([{ type: 'failed', refusal: 'failed' }], { kind: 'waiting', leaving: 'left' }).stage).toEqual(SEALED);
    expect(play([{ type: 'failed', refusal: 'failed' }], WAITING).stage).toEqual({ kind: 'sealed', refusal: 'failed' });
  });

  it('puts the pack back sealed, saying why, when the save changed under the tear', () => {
    expect(play([{ type: 'tear' }, { type: 'spend', blocked: true }]).stage).toEqual({ kind: 'sealed', refusal: 'blocked' });
    expect(play([{ type: 'refuse', refusal: 'blocked' }]).stage).toEqual({ kind: 'sealed', refusal: 'blocked' });
  });

  it('clears a refusal on leaving it, and starts a new tear from it', () => {
    const refused: PackStage = { kind: 'sealed', refusal: 'failed' };
    expect(play([{ type: 'leave' }], refused).stage).toEqual(SEALED);
    expect(play([{ type: 'tear' }], refused).stage).toEqual({ kind: 'tearing' });
  });

  it('ignores an event that does not fit the stage, returning the same stage object', () => {
    const summary: PackStage = { kind: 'summary' };
    for (const [stage, event] of [
      [SEALED, landed],
      [SEALED, { type: 'finish' }],
      [SEALED, { type: 'close' }],
      [SEALED, { type: 'leave' }],
      [{ kind: 'tearing' }, { type: 'tear' }],
      [{ kind: 'tearing' }, landed],
      [WAITING, { type: 'finish' }],
      [WAITING, { type: 'spend', blocked: false }],
      [REVEALING, { type: 'tear' }],
      [REVEALING, { type: 'close' }],
      [summary, { type: 'finish' }],
      [summary, { type: 'unmount' }],
    ] as [PackStage, PackEvent][]) {
      expect(transition(stage, event).stage).toBe(stage);
      expect(transition(stage, event).record).toBeNull();
    }
  });
});
