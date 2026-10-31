// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

// The guard for src/test/isolation.ts (not imported here: importing it would register its hooks in this file). Each pair leaves state behind in its first test and expects the
// second to start clean, so removing the setup file (or one of its resets) fails the second test.
// `shuffle: false` keeps a pair in order under --sequence.shuffle; a reversed pair would test nothing.
const queued = vi.fn<() => string | undefined>();

let entriesAfterLeak = 0;

describe('address', { shuffle: false }, () => {
  it('starts at the app address (jsdom itself starts at /), then leaves a fragment, a path and a history entry behind', () => {
    expect(location.pathname + location.search + location.hash).toBe('/BrainrotTCG/');
    history.pushState(null, '', '/BrainrotTCG/#/somewhere');
    history.replaceState(null, '', '/BrainrotTCG/profile#/pull/leaked');
    entriesAfterLeak = history.length;
  });

  it('is back at the app address, with no fragment and no history entry added by the reset', () => {
    expect(location.pathname + location.search + location.hash).toBe('/BrainrotTCG/');
    expect(history.length).toBe(entriesAfterLeak);
  });
});

describe('jsdom prototype spies', { shuffle: false }, () => {
  it('leaves play() stubbed', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    expect(vi.isMockFunction(HTMLMediaElement.prototype.play)).toBe(true);
  });

  it('starts with jsdom\'s own play and load', () => {
    expect(vi.isMockFunction(HTMLMediaElement.prototype.play)).toBe(false);
    expect(vi.isMockFunction(HTMLMediaElement.prototype.load)).toBe(false);
  });
});

describe('module-level mocks', { shuffle: false }, () => {
  it('leaves a queued once-value and a call behind', () => {
    queued.mockReturnValueOnce('leaked');
    expect(queued()).toBe('leaked');
    queued.mockReturnValueOnce('never consumed');
    expect(queued.mock.calls).toHaveLength(1);
  });

  it('starts with no queued value and no recorded call', () => {
    expect(queued.mock.calls).toHaveLength(0);
    expect(queued()).toBeUndefined();
  });
});
