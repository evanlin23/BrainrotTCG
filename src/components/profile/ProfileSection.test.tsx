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
