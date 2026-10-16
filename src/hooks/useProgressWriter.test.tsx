// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeldProgress, ProgressWriter, ProgressWriterHost } from '../game/progressWriter';
import { useProgressWriter } from './useProgressWriter';

const created = vi.hoisted(() => [] as { host: unknown; writer: unknown }[]);
vi.mock('../game/progressWriter', () => ({
  createProgressWriter: (host: unknown) => {
    const writer = { commit: vi.fn(), packAdded: vi.fn(), packsTaken: vi.fn(), putBackTaken: vi.fn() };
    created.push({ host, writer });
    return writer;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const progress = {} as HeldProgress;
const host = (): ProgressWriterHost => ({
  samePlayer: () => true, progressCurrent: () => true, noted: () => {}, stale: () => {}, failed: () => {}, keptAside: () => {},
});

let root: Root;
let writers: ProgressWriter[];
const Probe = ({ host: current }: { host: ProgressWriterHost }) => {
  writers.push(useProgressWriter(progress, current));
  return null;
};
const render = (current: ProgressWriterHost) => act(() => root.render(<Probe host={current} />));

beforeEach(() => {
  created.length = 0;
  writers = [];
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('useProgressWriter', () => {
  it('warns once in development when the host changes after the first render, and keeps its writer', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = host();
    render(first);
    render(first);
    expect(error).not.toHaveBeenCalled();
    render(host());
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('useProgressWriter: the host changed after the first render');
    render(host());
    render(first);
    expect(error).toHaveBeenCalledTimes(1);
    // One writer, built from the first host, for every render.
    expect(created).toHaveLength(1);
    expect(created[0].host).toBe(first);
    expect(writers.length).toBeGreaterThanOrEqual(5);
    expect(new Set(writers)).toEqual(new Set([created[0].writer]));
  });

  it('says nothing in a production build', () => {
    vi.stubEnv('DEV', false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(host());
    render(host());
    expect(error).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
  });
});
