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
 * entries and the next Back would seem to do nothing. It's marked as followed instead
 * (`brainrotSetLink`), so coming back to it (closing a page opened over it, Back or Forward) doesn't
 * choose its set again over one the player has picked since. Only a link that was followed is marked:
 * one that arrived while a pack was open is left as it is, to be followed when it's next shown.
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
      const state: unknown = history.state;
      const entry = state && typeof state === 'object' ? state as { brainrotSetLink?: boolean } : {};
      if (entry.brainrotSetLink) return;
      const { sets, busy, select } = latest.current;
      const followed = !busy && sets.some((s) => s.id === setId && isOpenable(s));
      if (followed) select(setId);
      if (loaded) history.replaceState(history.state, '', location.pathname + location.search);
      else if (followed) history.replaceState({ ...entry, brainrotSetLink: true }, '');
    };
    follow(true);
    const onHashChange = () => follow(false);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
};
