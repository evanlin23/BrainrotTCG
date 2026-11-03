// @vitest-environment jsdom
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import { SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';
import { setMotionSetting } from '../../utils/motion';
import type { CardWithMeta } from '../cards/Card';
import CardRevealUI from './CardRevealUI';

/** What the reveal card was handed to animate: framer-motion's button is swapped for a plain one that records it. */
const handed = vi.hoisted(() => ({ last: null as null | { animate: { scale: number | number[] }; transition: { duration: number } } }));
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  const button = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'> & { animate?: never; transition?: never }>((props, ref) => {
    const { animate, transition, initial, exit, drag, dragSnapToOrigin, dragElastic, onDragEnd, ...rest } = props as Record<string, unknown>;
    void initial; void exit; void drag; void dragSnapToOrigin; void dragElastic; void onDragEnd;
    handed.last = { animate, transition } as never;
    return <button ref={ref} {...(rest as ComponentPropsWithoutRef<'button'>)} />;
  });
  return { ...actual, motion: new Proxy(actual.motion, { get: (target, key) => (key === 'button' ? button : Reflect.get(target, key)) }) };
});

const card: CardWithMeta = { ...ALL_CARDS[0], rarity: 'BRAINROT', uniqueId: 1, isRevealed: true, isHolo: false, finish: null };
let root: Root;

const show = (props: { celebrating: boolean; card?: CardWithMeta }) => act(() => root.render(
  <CardRevealUI currentCard={props.card ?? card} currentIndex={0} totalCards={5} hasMovedMouse onInteraction={() => {}} onSkip={() => {}} celebrating={props.celebrating} />,
));
/** The device's media queries: `reduce` answers the reduced-motion one only. */
const device = (reduce: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  device(false);
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(() => {
  act(() => root.unmount());
  setMotionSetting('auto');
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the big card\'s celebration tween (#1289)', () => {
  it('bounces over the celebration\'s 3 s when motion is allowed', () => {
    show({ celebrating: true });
    expect(handed.last!.animate.scale).toEqual([1, 1.055, 1.03]);
    expect(handed.last!.transition.duration).toBe(SPECIAL_REVEAL_DURATION_MS / 1000);
  });

  it.each([
    ['the Motion setting', () => setMotionSetting('reduced')],
    ['the device', () => device(true)],
  ])('lands on its end scale at once when %s asks for reduced motion', (_name, reduce) => {
    reduce();
    show({ celebrating: true });
    expect(handed.last!.animate.scale).toBe(1.03);
    expect(handed.last!.transition.duration).toBe(0);
  });

  it('keeps an ordinary card\'s short settle, with or without the celebration over', () => {
    setMotionSetting('reduced');
    show({ celebrating: false });
    expect(handed.last!.animate.scale).toBe(1.03);
    expect(handed.last!.transition.duration).toBe(0.22);
  });
});
