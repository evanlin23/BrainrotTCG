/** Run `task` when the browser is idle (or after `timeout` ms at the latest). Returns a cancel. */
export const whenIdle = (task: () => void, timeout = 2000): (() => void) => {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(() => task(), { timeout });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(task, 200);
  return () => clearTimeout(handle);
};
