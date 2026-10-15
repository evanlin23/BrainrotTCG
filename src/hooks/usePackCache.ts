import { useSyncExternalStore } from 'react';
import { onPackCacheChange, packCacheVersion } from '../game/profiles';

/** Changes whenever reading saved packs starts, finishes or fails: a memo dependency for stats. */
export const usePackCacheVersion = (): number => useSyncExternalStore(onPackCacheChange, packCacheVersion);
