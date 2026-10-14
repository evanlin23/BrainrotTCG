import { DEFAULT_SET_ID } from '../content/sets';
import { STORAGE_KEYS } from '../constants';

export function readSelectedSet(): string {
  try {
    return localStorage.getItem(STORAGE_KEYS.SELECTED_SET) ?? DEFAULT_SET_ID;
  } catch {
    return DEFAULT_SET_ID;
  }
}

export function saveSelectedSet(setId: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS.SELECTED_SET, setId);
  } catch {
    // The active choice still works in memory if this preference cannot be saved.
  }
}
