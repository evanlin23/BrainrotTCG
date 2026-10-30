// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SETS } from '../../content/sets';
import PackCuttingUI, { TAP_SLOP_PX } from './PackCuttingUI';

// A browser has AnimationEvent, so React listens for animationend. jsdom 27+ has no AnimationEvent but its
// cssstyle (5) now has WebkitAnimation, which makes React listen for webkitAnimationEnd instead; jsdom 26
// had neither. This runs before react-dom reads the window (the imports below are hoisted after it).
vi.hoisted(() => {
  Object.defineProperty(window, 'AnimationEvent', { value: class AnimationEvent extends Event {}, configurable: true });
});

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
    <PackCuttingUI packRef={createRef<HTMLDivElement>()} packDesign="pack.png" set={SETS[0]} onOpen={onOpen} isCutting={false} isPackCut={false} cutPoints={[]} />,
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

const pointer = (type: string, target: EventTarget, x: number, y: number) => act(() => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
});

it('swallows the click of a press that strayed past the slop and came back before its release', () => {
  press(100, 200);
  pointer('pointermove', window, 100 + TAP_SLOP_PX * 4, 200);
  pointer('pointermove', window, 101, 200);
  click(101, 200);
  expect(onOpen).not.toHaveBeenCalled();
});

it('counts a wobble inside the slop as a tap', () => {
  press(100, 200);
  pointer('pointermove', window, 100 + TAP_SLOP_PX - 2, 200);
  pointer('pointermove', window, 98, 203);
  click(99, 201);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('forgets a press that ended off the pack, so a later click with no press before it still opens', () => {
  press(40, 200);
  pointer('pointermove', window, 400, 200);
  pointer('pointerup', document.body, 400, 200);
  click(0, 0);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('forgets a press the browser cancelled (a scroll or a call took it)', () => {
  press(40, 200);
  pointer('pointermove', window, 400, 200);
  pointer('pointercancel', pack(), 400, 200);
  click(0, 0);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('keeps a press that ended on the pack for the click that follows it', () => {
  press(40, 200);
  pointer('pointermove', window, 400, 200);
  pointer('pointerup', pack(), 40, 200);
  click(40, 200);
  expect(onOpen).not.toHaveBeenCalled();
});

it('tells the cue the pack was touched on a press', () => {
  const onTouch = vi.fn();
  act(() => root.render(
    <PackCuttingUI packRef={createRef<HTMLDivElement>()} packDesign="pack.png" set={SETS[0]} onOpen={onOpen} onTouch={onTouch} isCutting={false} isPackCut={false} cutPoints={[]} cue="play" />,
  ));
  expect(container.querySelector('.open-cue')).not.toBeNull();
  press(10, 10);
  expect(onTouch).toHaveBeenCalledTimes(1);
});

it('ends the cue when its finger finishes, but not when something inside it does', () => {
  const onCueEnd = vi.fn();
  act(() => root.render(
    <PackCuttingUI packRef={createRef<HTMLDivElement>()} packDesign="pack.png" set={SETS[0]} onOpen={onOpen} onCueEnd={onCueEnd} isCutting={false} isPackCut={false} cutPoints={[]} cue="play" />,
  ));
  const travel = container.querySelector<HTMLElement>('.open-cue-travel')!;
  act(() => { travel.querySelector('svg')!.dispatchEvent(new Event('animationend', { bubbles: true })); });
  expect(onCueEnd).not.toHaveBeenCalled();
  act(() => { travel.dispatchEvent(new Event('animationend', { bubbles: true })); });
  expect(onCueEnd).toHaveBeenCalledTimes(1);
});
