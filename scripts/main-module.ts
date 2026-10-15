import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `moduleUrl` (pass `import.meta.url`) is the script Node was started with.
 * Compares real paths, so a launch through a symlink (a linked checkout, /tmp on macOS, a bin link)
 * still runs the script instead of silently exiting 0. If either path can't be resolved, it falls
 * back to comparing absolute paths.
 */
export const isMainModule = (moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean => {
  if (!argv1) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    return path.resolve(argv1) === path.resolve(modulePath);
  }
};
