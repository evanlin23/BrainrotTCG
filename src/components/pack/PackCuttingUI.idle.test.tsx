// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SETS } from '../../content/sets';
import PackCuttingUI from './PackCuttingUI';

// Present until a test says the pack has started leaving (it is then in the middle of an exit).
const present = vi.hoisted(() => ({ value: true }));
vi.mock('framer-motion', async (importOriginal) => ({ ...(await importOriginal<typeof import('framer-motion')>()), useIsPresent: () => present.value }));

let root: Root;
let container: HTMLDivElement;

const ui = (props: Partial<React.ComponentProps<typeof PackCuttingUI>> = {}) => (
  <PackCuttingUI packRef={createRef<HTMLDivElement>()} packDesign="pack.png" set={SETS[0]} onOpen={() => {}} isCutting={false} isPackCut={false} cutPoints={[]} sparks={[]} {...props} />
);

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  present.value = true;
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root.render(ui()));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const pack = () => container.querySelector<HTMLElement>('[data-pack-open]')!;
const idle = () => container.querySelector('.pack-shell')!.classList.contains('is-idle');
const fire = (type: string, target: EventTarget, pointerId = 1) => act(() => {
  const event = new MouseEvent(type, { bubbles: true, clientX: 100, clientY: 400 });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  target.dispatchEvent(event);
});

it('is on for a sealed pack nobody is touching', () => {
  expect(idle()).toBe(true);
});

it('stays down for as long as a finger is held below the tear line, whatever the nudge timer does, and returns when it lifts', () => {
  // A press below the start band sets no pressing and no cutting; only the nudge (a timer) and the hold itself speak for it.
  fire('pointerdown', pack());
  expect(idle()).toBe(false);
  // The nudge's timer has run out under a slow hold: the hint is gone, the finger is not.
  act(() => { root.render(ui({ nudging: false, pressing: false })); });
  expect(idle()).toBe(false);
  fire('pointermove', window);
  expect(idle()).toBe(false);
  fire('pointerup', window);
  expect(idle()).toBe(true);
});

it('returns when the browser takes the press over (a scroll, a call)', () => {
  fire('pointerdown', pack());
  expect(idle()).toBe(false);
  fire('pointercancel', window);
  expect(idle()).toBe(true);
});

it('lets go only for the finger that was down, not for another pointer', () => {
  fire('pointerdown', pack(), 7);
  fire('pointerup', window, 8);
  expect(idle()).toBe(false);
  fire('pointerup', window, 7);
  expect(idle()).toBe(true);
});

it('is gone while the pack is leaving, whatever else says it is idle', async () => {
  present.value = false;
  await act(async () => root.render(ui({ isPackCut: false })));
  expect(idle()).toBe(false);
  present.value = true;
  await act(async () => root.render(ui()));
  expect(idle()).toBe(true);
});
