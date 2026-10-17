import { useEffect, useRef } from 'react';
import { isOpenable } from '../content/sets';
import type { SetDefinition } from '../engine';
import { setIdFromHash } from '../game/route';

/**
 * A set's link (s/<set id>/ forwards to #/set/<set id>) opens the packs screen on that set, if it's
 * one of `sets` and released, and not while a pack is open (`busy`).
 *
 * Arriving that way, the hash only carries the choice, so it's dropped from the loaded entry, leaving
 * the plain Open address. Typed over a running app, the browser has already added an entry for it on
 * top of the one showing: that entry keeps its hash, since dropping it would leave two identical
 * entries and the next Back would seem to do nothing.
 */
export const useSetLink = (sets: readonly SetDefinition[], busy: boolean, select: (setId: string) => void) => {
  const latest = useRef({ sets, busy, select });
  useEffect(() => {
    latest.current = { sets, busy, select };
  });
  useEffect(() => {
    const follow = (loaded: boolean) => {
      const setId = setIdFromHash(location.hash);
      if (!setId) return;
      const { sets, busy, select } = latest.current;
      if (!busy && sets.some((s) => s.id === setId && isOpenable(s))) select(setId);
      if (loaded) history.replaceState(history.state, '', location.pathname + location.search);
    };
    follow(true);
    const onHashChange = () => follow(false);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
};
