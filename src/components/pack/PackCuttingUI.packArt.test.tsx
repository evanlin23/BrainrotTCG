// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETS } from '../../content/sets';
import PackCuttingUI from './PackCuttingUI';

const packArt = vi.hoisted(() => ({ packArtSettled: vi.fn() }));
vi.mock('../../game/packArt', () => packArt);

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  packArt.packArtSettled.mockClear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root.render(
    <PackCuttingUI
      packRef={createRef<HTMLDivElement>()} packDesign="pack.png" set={SETS[0]} refusal={null} onOpen={() => {}}
      isCutting={false} pressing={false} nudging={false} fellShort={false} isPackCut={false} waiting={false}
      cutPoints={[]} sparks={[]}
    />,
  ));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const wrapper = () => container.querySelector('.pack-half-bottom > img')!;

describe("the sealed pack's art", () => {
  it.each(['load', 'error'])('lets the deferred downloads start once it %ss, not before (#776)', (event) => {
    expect(packArt.packArtSettled).not.toHaveBeenCalled();
    act(() => { wrapper().dispatchEvent(new Event(event)); });
    expect(packArt.packArtSettled).toHaveBeenCalledOnce();
  });
});
