import { useSyncExternalStore } from 'react';

/** Sheets currently open, newest last: only the top one reacts to Escape and owns focus. */
const stack: string[] = [];
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

export const openSheet = (id: string) => {
  stack.push(id);
  notify();
};

/** Takes the sheet out and says whether none is left open. */
export const closeSheet = (id: string): boolean => {
  const at = stack.indexOf(id);
  if (at !== -1) stack.splice(at, 1);
  notify();
  return stack.length === 0;
};

export const isTopSheet = (id: string) => stack[stack.length - 1] === id;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** True while any sheet is open (Share, a card close-up, a shared link): the achievement toasts wait for it to close. */
export const useAnySheetOpen = () => useSyncExternalStore(subscribe, () => stack.length > 0, () => false);
