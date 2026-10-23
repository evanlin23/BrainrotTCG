// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SETS } from '../../content/sets';
import PackCuttingUI from './PackCuttingUI';
import { warmUpArgon2 } from '../../game/warmUp';

// The Argon2 chunk is a dynamic import; each evaluation of its module is one fetch.
const fetches = vi.hoisted(() => [] as number[]);
vi.mock('../../engine/argon2', () => {
  fetches.push(1);
  return { argon2id: vi.fn() };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestIdleCallback', undefined);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("fetches Argon2 even when the sealed pack leaves before its art loads or fails (#776)", async () => {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  act(() => root.render(
    <PackCuttingUI
      packRef={createRef<HTMLDivElement>()} packDesign="pack.png" set={SETS[0]} refusal={null} onOpen={() => {}}
      isCutting={false} pressing={false} nudging={false} fellShort={false} isPackCut={false} waiting={false}
      cutPoints={[]} sparks={[]}
    />,
  ));
  warmUpArgon2();
  // The art hasn't settled: the warm-up waits for it.
  await Promise.resolve();
  vi.runAllTimers();
  await vi.dynamicImportSettled();
  expect(fetches).toEqual([]);

  // The player moves on from Open before it does.
  act(() => root.unmount());
  container.remove();
  await Promise.resolve();
  vi.runAllTimers();
  await vi.dynamicImportSettled();
  expect(fetches).toEqual([1]);
});
