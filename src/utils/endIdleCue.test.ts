// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { endIdleCue } from './endIdleCue';

afterEach(() => vi.restoreAllMocks());

const animation = (animationName: string, target: Element, calls: string[]) =>
  ({ animationName, effect: { target }, cancel: () => calls.push(`cancel ${animationName}`) }) as unknown as Animation;

it('ends the idle lift and applies that before returning, and leaves every other animation running', () => {
  const calls: string[] = [];
  const pack = document.createElement('div');
  const strip = document.createElement('div');
  strip.className = 'pack-half-top';
  pack.append(strip);
  pack.getAnimations = (options) => {
    expect(options).toEqual({ subtree: true });
    return [animation('pack-foil', strip, calls), animation('pack-idle-lift', strip, calls)];
  };
  vi.spyOn(window, 'getComputedStyle').mockImplementation((target) => {
    calls.push(`style ${(target as Element).className}`);
    return { transform: 'none' } as CSSStyleDeclaration;
  });

  endIdleCue(pack);

  // The style read follows the cancel, so the tear's update starts from rest.
  expect(calls).toEqual(['cancel pack-idle-lift', 'style pack-half-top']);
});

it('does nothing for a pack that is not there or a page that cannot list animations', () => {
  expect(() => endIdleCue(null)).not.toThrow();
  expect(() => endIdleCue(document.createElement('div'))).not.toThrow();
});
