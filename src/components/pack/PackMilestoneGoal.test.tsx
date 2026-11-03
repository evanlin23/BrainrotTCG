// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PackMilestoneGoal from './PackMilestoneGoal';
import type { SetDefinition } from '../../engine';
import { getNextMilestone, type NextMilestoneGoal } from '../../game/nextMilestone';

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
  targetName: 'Pack Rat',
  targetKind: 'title',
  detail: 'Cosmetic, odds unchanged · Lv 3',
  progressText: '50%',
  progressLabel: '50% of the way to level 3',
  progressPct: 50,
  action: { text: 'Select rewards', target: 'rewards' },
};

const binder: NextMilestoneGoal = {
  kind: 'set-complete',
  targetName: 'Base Set complete',
  detail: '12/20 cards, 8 to go',
  progressText: '12/20',
  progressLabel: '12 of 20',
  progressPct: 60,
  action: { text: 'View binder', target: 'cards' },
};

// Built by the rules that build it on the pack screen, so a change to the goal's words is seen here too.
const master = getNextMilestone(
  { xp: 0, uniqueBySet: { 'six-seven-season': 12 }, holoUniqueBySet: { 'six-seven-season': 8 } },
  { id: 'six-seven-season', name: 'Six Seven Season', cards: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}` })) } as unknown as SetDefinition,
);

const done: NextMilestoneGoal = {
  kind: 'done',
  targetName: 'Base Set mastered',
  detail: 'Every reward is unlocked',
  progressText: 'Done',
  progressLabel: 'Done',
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
      'Next goal: Pack Rat (title), 50% of the way to level 3. Cosmetic, odds unchanged · Lv 3. Select rewards.',
    );
    expect(container.querySelector('.pack-milestone-target')!.textContent).toBe('Pack Rat');
    expect(container.querySelector('.pack-milestone-kind')!.textContent).toBe(' title');
    expect(container.querySelector('.pack-milestone-progress')!.textContent).toBe('50%');
    // The cosmetic cue is on-screen text, not only in the label, so a phone reads it too.
    expect(container.querySelector('.pack-milestone-detail')!.textContent).toBe('Cosmetic, odds unchanged · Lv 3');
    expect(container.querySelector<HTMLElement>('.pack-milestone-fill')!.style.width).toBe('50%');
    // One control, nothing nested in it.
    expect(container.querySelectorAll('button, a, [role="progressbar"]')).toHaveLength(1);
    act(() => button.click());
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('rewards');
  });

  it('shows a card back goal with a picture of that back, and no picture for a title', () => {
    render({ ...cosmetic, targetName: 'Midnight', targetKind: 'card back', preview: { kind: 'card-back', id: 'midnight' } });
    const swatch = container.querySelector('button.pack-milestone > .back-swatch')!;
    expect(swatch.classList.contains('back-midnight')).toBe(true);
    expect(swatch.querySelector('img')!.getAttribute('alt')).toBe('');
    render(cosmetic);
    expect(container.querySelector('.back-swatch')).toBeNull();
  });

  it('sends a set goal to the binder', () => {
    const onNavigate = render(binder);
    act(() => container.querySelector<HTMLButtonElement>('button.pack-milestone')!.click());
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('cards');
  });

  it('names the unit of a master set count on screen and in the accessible name (#898)', () => {
    render(master);
    expect(container.querySelector('.pack-milestone-progress')!.textContent).toBe('8/12 holos');
    expect(container.querySelector('.pack-milestone-detail')!.textContent).toBe('4 to go');
    expect(container.querySelector('button.pack-milestone')!.getAttribute('aria-label')).toBe(
      'Next goal: Six Seven Season master set, 8 of 12 holos. 4 to go. View binder.',
    );
    // The tooltip names the unit too, not only the cue.
    expect(container.querySelector('button.pack-milestone')!.getAttribute('title')).toBe('Six Seven Season master set: 8 of 12 holos, 4 to go');
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
