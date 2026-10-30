// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PackMilestoneGoal from './PackMilestoneGoal';
import type { NextMilestoneGoal } from '../../game/nextMilestone';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const cosmetic: NextMilestoneGoal = {
  kind: 'cosmetic',
  targetName: 'Pack Rat (title)',
  detail: 'Level 3 cosmetic: rarity and odds stay the same',
  progressText: '50% to level 3',
  progressPct: 50,
  action: { text: 'Select rewards', target: 'rewards' },
};

const binder: NextMilestoneGoal = {
  kind: 'set-complete',
  targetName: 'Base Set complete',
  detail: '12/20 cards, 8 to go',
  progressText: '12/20',
  progressPct: 60,
  action: { text: 'View binder', target: 'cards' },
};

const done: NextMilestoneGoal = {
  kind: 'done',
  targetName: 'Base Set mastered',
  detail: 'Every reward is unlocked',
  progressText: 'Done',
  progressPct: 100,
};

const render = (goal: NextMilestoneGoal, onNavigate = vi.fn(), disabled?: boolean) => {
  act(() => root.render(<PackMilestoneGoal goal={goal} onNavigate={onNavigate} disabled={disabled} />));
  return onNavigate;
};

describe('PackMilestoneGoal', () => {
  it('is one button that names the goal, its progress and that odds do not change, and goes to the rewards', () => {
    const onNavigate = render(cosmetic);
    const button = container.querySelector<HTMLButtonElement>('button.pack-milestone')!;
    expect(button.getAttribute('aria-label')).toBe(
      'Next goal: Pack Rat (title), 50% to level 3. Level 3 cosmetic: rarity and odds stay the same. Select rewards.',
    );
    expect(container.querySelector('.pack-milestone-target')!.textContent).toBe('Pack Rat (title)');
    expect(container.querySelector('.pack-milestone-progress')!.textContent).toBe('50% to level 3');
    expect(container.querySelector<HTMLElement>('.pack-milestone-fill')!.style.width).toBe('50%');
    // One control, nothing nested in it.
    expect(container.querySelectorAll('button, a, [role="progressbar"]')).toHaveLength(1);
    act(() => button.click());
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('rewards');
  });

  it('sends a set goal to the binder', () => {
    const onNavigate = render(binder);
    act(() => container.querySelector<HTMLButtonElement>('button.pack-milestone')!.click());
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('cards');
  });

  it('is plain text with no button once everything is done', () => {
    render(done);
    expect(container.querySelector('button')).toBeNull();
    const group = container.querySelector('.pack-milestone')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Next goal: Base Set mastered, Done. Every reward is unlocked.');
    expect(container.querySelector<HTMLElement>('.pack-milestone-fill')!.style.width).toBe('100%');
  });

  it('is disabled while a dialog is open, and keeps a progress outside 0-100 inside the bar', () => {
    const onNavigate = render({ ...cosmetic, progressPct: 140 }, vi.fn(), true);
    const button = container.querySelector<HTMLButtonElement>('button.pack-milestone')!;
    expect(button.disabled).toBe(true);
    expect(container.querySelector<HTMLElement>('.pack-milestone-fill')!.style.width).toBe('100%');
    act(() => button.click());
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
