import { describe, expect, it } from 'vitest';
import { SETS } from '../content/sets';
import type { SetDefinition } from '../engine';
import { canOpenSharedSet } from './sharedPullSet';

const set = (over: Partial<SetDefinition> = {}): SetDefinition => ({ ...SETS[SETS.length - 1], ...over }) as SetDefinition;

describe('canOpenSharedSet', () => {
  const latest = set({ id: 'x', version: 2, draft: undefined, archivedAt: undefined });

  it('is true for the exact set id and version', () => {
    expect(canOpenSharedSet(set({ id: 'x', version: 2 }), [latest], false)).toBe(true);
  });

  it('is false for an older proof version of a set whose latest version is different', () => {
    expect(canOpenSharedSet(set({ id: 'x', version: 1 }), [latest], false)).toBe(false);
  });

  it('is false for a set that is not listed', () => {
    expect(canOpenSharedSet(set({ id: 'y', version: 2 }), [latest], false)).toBe(false);
  });

  it('is false for an archived set', () => {
    const archived = set({ id: 'x', version: 2, archivedAt: '2026-01-01' });
    expect(canOpenSharedSet(archived, [archived], false)).toBe(false);
  });

  it('is false for a draft set, even when drafts are listed', () => {
    const draft = set({ id: 'x', version: 2, draft: true });
    expect(canOpenSharedSet(draft, [draft], false)).toBe(false);
  });

  it('is false while a pack is open', () => {
    expect(canOpenSharedSet(latest, [latest], true)).toBe(false);
  });

  it('checks the real registry: genesis at its listed version opens, a made-up version does not', () => {
    const real = SETS.find((s) => !s.draft && !s.archivedAt)!;
    expect(canOpenSharedSet(real, SETS, false)).toBe(true);
    expect(canOpenSharedSet({ ...real, version: real.version + 1 }, SETS, false)).toBe(false);
  });
});
