// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SETS } from '../../content/sets';
import PackCuttingUI, { TAP_SLOP_PX } from './PackCuttingUI';

let root: Root;
let container: HTMLDivElement;
const onOpen = vi.fn();

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  onOpen.mockClear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root.render(
    <PackCuttingUI packRef={createRef<HTMLDivElement>()} packDesign="pack.png" set={SETS[0]} onOpen={onOpen} isCutting={false} isPackCut={false} cutPoints={[]} sparks={[]} />,
  ));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const pack = () => container.querySelector<HTMLElement>('[data-pack-open]')!;
const press = (x: number, y: number) => act(() => { pack().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })); });
const click = (x: number, y: number) => act(() => { pack().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })); });

it('opens the pack once for a click that follows a press where it stayed', () => {
  press(100, 200);
  click(100 + TAP_SLOP_PX - 1, 200);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('opens it for a click with no press before it, as a screen reader or switch makes', () => {
  click(0, 0);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('swallows the click a swipe ends in, so a swipe never opens twice', () => {
  press(40, 200);
  click(40 + TAP_SLOP_PX + 1, 200);
  expect(onOpen).not.toHaveBeenCalled();
  // The next, stationary press is a tap again.
  press(40, 200);
  click(40, 200);
  expect(onOpen).toHaveBeenCalledTimes(1);
});
