// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ProfileSection from './ProfileSection';

it('folds sections independently, keeps their state, and reopens a linked section on each request', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  function Counter() {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
  }
  const render = (openRequest?: number) => act(() => root.render(<>
    <ProfileSection title="Records"><Counter /></ProfileSection>
    <ProfileSection title="Rewards" openRequest={openRequest}>Choices</ProfileSection>
  </>));
  const folds = () => [...container.querySelectorAll('details')];
  const toggle = (fold: HTMLDetailsElement) => act(() => {
    fold.querySelector('summary')!.click();
    fold.dispatchEvent(new Event('toggle'));
  });
  try {
    render();
    expect(folds().map((fold) => fold.open)).toEqual([false, false]);
    toggle(folds()[0]);
    expect(folds().map((fold) => fold.open)).toEqual([true, false]);
    act(() => container.querySelector('button')!.click());
    toggle(folds()[0]);
    toggle(folds()[0]);
    expect(container.querySelector('button')!.textContent).toBe('Count 1');
    render(1);
    expect(folds().map((fold) => fold.open)).toEqual([true, true]);
    toggle(folds()[1]);
    render(1);
    expect(folds()[1].open).toBe(false);
    render(2);
    expect(folds()[1].open).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('opens when a notice needs attention, says so in its header, lets the player close it, and opens again for the next one', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const render = (attention: string | null, extra: { note?: string; hideNoteWhenOpen?: boolean } = {}) =>
    act(() => root.render(<ProfileSection title="Totals" attention={attention} {...extra}>Body</ProfileSection>));
  const fold = () => container.querySelector('details')!;
  const note = () => container.querySelector('.profile-fold-note')?.textContent;
  try {
    render(null, { note: '3 of 9 unlocked' });
    expect(fold().open).toBe(false);
    expect(note()).toBe('3 of 9 unlocked');
    render('Needs attention', { note: '3 of 9 unlocked' });
    expect(fold().open).toBe(true);
    expect(note()).toBe('Needs attention');
    act(() => {
      fold().open = false;
      fold().dispatchEvent(new Event('toggle'));
    });
    expect(note()).toBe('Needs attention');
    render('Needs attention');
    expect(fold().open).toBe(false);
    render(null);
    render('Needs attention');
    expect(fold().open).toBe(true);
    root.unmount();

    // Already needing attention when first shown: it starts open.
    const second = createRoot(container);
    act(() => second.render(<ProfileSection title="Totals" attention="Couldn't read">Body</ProfileSection>));
    expect(fold().open).toBe(true);
    act(() => second.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('hides a note that the open body already says, and shows it again once closed', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  try {
    act(() => root.render(<ProfileSection title="Achievements" note="2/9 unlocked" hideNoteWhenOpen openRequest={1}>2/9 unlocked · 22%</ProfileSection>));
    expect(container.querySelector('.profile-fold-note')).toBeNull();
    const fold = container.querySelector('details')!;
    act(() => {
      fold.open = false;
      fold.dispatchEvent(new Event('toggle'));
    });
    expect(container.querySelector('.profile-fold-note')?.textContent).toBe('2/9 unlocked');
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
