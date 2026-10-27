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

const mockCosmeticGoal: NextMilestoneGoal = {
  kind: 'cosmetic',
  title: 'Next cosmetic unlock',
  targetName: 'Pack Rat (title)',
  detail: 'Level 3 cosmetic (does not change odds)',
  progressText: '50% to Level 3',
  progressPct: 50,
  actionText: 'Select rewards',
  actionTarget: 'rewards',
  previewBadge: 'Lvl 3',
};

const mockSetGoal: NextMilestoneGoal = {
  kind: 'set-complete',
  title: 'Set milestone',
  targetName: 'Base Set Complete',
  detail: '12/20 cards collected (8 to go)',
  progressText: '60%',
  progressPct: 60,
  actionText: 'View binder',
  actionTarget: 'cards',
  previewBadge: '12/20',
};

describe('PackMilestoneGoal', () => {
  it('renders cosmetic goal with disclaimer and navigates to rewards on click', () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(<PackMilestoneGoal goal={mockCosmeticGoal} onNavigate={onNavigate} />);
    });

    expect(container.querySelector('.pack-milestone-kicker')!.textContent).toBe('Next cosmetic unlock');
    expect(container.querySelector('.pack-milestone-target')!.textContent).toBe('Pack Rat (title)');
    expect(container.querySelector('.pack-milestone-badge')!.textContent).toBe('Lvl 3');
    expect(container.querySelector('.pack-milestone-detail')!.textContent).toContain('(does not change odds)');
    expect(container.querySelector('.pack-milestone-progress-text')!.textContent).toBe('50% to Level 3');

    const progressBar = container.querySelector('[role="progressbar"]')!;
    expect(progressBar.getAttribute('aria-valuenow')).toBe('50');

    const fill = container.querySelector<HTMLElement>('.pack-milestone-bar-fill')!;
    expect(fill.style.width).toBe('50%');

    const button = container.querySelector<HTMLButtonElement>('.pack-milestone-action')!;
    expect(button.textContent).toContain('Select rewards');
    act(() => button.click());
    expect(onNavigate).toHaveBeenCalledWith('rewards');
  });

  it('renders set completion goal and navigates to cards on click', () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(<PackMilestoneGoal goal={mockSetGoal} onNavigate={onNavigate} />);
    });

    expect(container.querySelector('.pack-milestone-kicker')!.textContent).toBe('Set milestone');
    expect(container.querySelector('.pack-milestone-target')!.textContent).toBe('Base Set Complete');
    expect(container.querySelector('.pack-milestone-badge')!.textContent).toBe('12/20');
    expect(container.querySelector('.pack-milestone-detail')!.textContent).toBe('12/20 cards collected (8 to go)');

    const button = container.querySelector<HTMLButtonElement>('.pack-milestone-action')!;
    expect(button.textContent).toContain('View binder');
    act(() => button.click());
    expect(onNavigate).toHaveBeenCalledWith('cards');
  });

  it('disables action button when disabled prop is true', () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(<PackMilestoneGoal goal={mockCosmeticGoal} onNavigate={onNavigate} disabled={true} />);
    });

    const button = container.querySelector<HTMLButtonElement>('.pack-milestone-action')!;
    expect(button.disabled).toBe(true);
  });
});
