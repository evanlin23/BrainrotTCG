/**
 * Safely retrieve and parse data from localStorage
 */
export const getStoredData = <T>(key: string, defaultValue: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultValue;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultValue;
    return parsed as T;
  } catch {
    return defaultValue;
  }
};

/**
 * Save data to localStorage
 */
export const setStoredData = <T>(key: string, data: T): void => {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (error) {
    console.error(`Failed to save to localStorage key "${key}":`, error);
  }
};

/**
 * Remove data from localStorage
 */
export const removeStoredData = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.error(`Failed to remove localStorage key "${key}":`, error);
  }
};
