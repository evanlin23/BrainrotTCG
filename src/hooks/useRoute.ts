import { useCallback, useEffect, useRef, useState } from 'react';
import { extractProof } from '../engine/proof';
import { extractProfile } from '../engine/profile';
import { recordDiagnostic } from '../game/diagnostics';
import { HISTORY_ENTRY_EVENT, isLinkHash, pageForHash, pageHash, type Page } from '../game/route';
import { routeShown } from '../game/warmUp';

/** A pull or profile link that got cut off or mangled on the way (chat apps do that). Your own `#/profile` page isn't one. */
export const isBrokenLink = (hash: string) => !pageForHash(hash) && isLinkHash(hash) && !extractProof(hash) && !extractProfile(hash);

/**
 * What the app keeps in each history entry it makes or sees, so Back, Forward and closing agree:
 * - `brainrotPack`: a pack's entry (usePackHistory), always on the Open route.
 * - `brainrotDepth`: how many page entries this one sits on above an Open entry, so closing a page
 *   steps back to that Open entry instead of piling a new one on. Missing when the page was the first
 *   thing loaded (closing it then swaps it for Open in place).
 * - `brainrotOverPack`: that Open entry is a pack's, still showing its summary.
 * - `brainrotLinks`: how many shared-link entries this one sits on above the page they opened over.
 * - `brainrotRoute`: that page, which stays behind the link's viewer.
 * - `brainrotSetLink`: a set's link typed over the app, already followed (useSetLink). It's an Open entry.
 */
type EntryState = {
  brainrotPack?: boolean;
  brainrotDepth?: number;
  brainrotOverPack?: boolean;
  brainrotLinks?: number;
  brainrotRoute?: Page;
  brainrotSetLink?: boolean;
};

/** An entry nothing has marked yet: one the browser just made for a link or page typed, pasted or followed. */
const unmarked = () => history.state === null || history.state === undefined;

const entryState = (): EntryState => {
  const state: unknown = history.state;
  return state && typeof state === 'object' ? state as EntryState : {};
};

/** Shared links arrive through a preview page (/p/<id>), which is only there for chat apps: in-app addresses leave it. */
const appPath = () => (/\/p\/[^/]+$/.test(location.pathname) ? import.meta.env.BASE_URL : location.pathname + location.search);

const routeOf = (hash: string, state: EntryState): Page =>
  pageForHash(hash) ?? (isLinkHash(hash) ? state.brainrotRoute ?? 'open' : 'open');

type Shown = { state: EntryState; route: Page };

/** The entry a page gets when it's added on top of `below`. */
const pageEntry = (below: Shown): EntryState => {
  if (below.state.brainrotLinks) return {};
  if (below.route === 'open') return { brainrotDepth: 1, brainrotOverPack: !!below.state.brainrotPack };
  const depth = below.state.brainrotDepth;
  return depth ? { brainrotDepth: depth + 1, brainrotOverPack: below.state.brainrotOverPack } : {};
};

const read = () => {
  const hash = location.hash;
  return {
    route: routeOf(hash, entryState()),
    proof: extractProof(hash),
    profile: extractProfile(hash),
    broken: isBrokenLink(hash),
  };
};

export type RouteState = ReturnType<typeof read>;

const same = (a: RouteState, b: RouteState) =>
  a.route === b.route && a.proof === b.proof && a.profile === b.profile && a.broken === b.broken;

/**
 * The page showing and any shared link open over it, from the address. Pages are hash routes
 * (#/cards, #/rankings, #/profile, #/settings); Open has no hash. Shared links (#/pull/<proof>,
 * #/profile/<id>) open a viewer over whichever page was showing.
 *
 * One history model with usePackHistory: every in-app move to a page adds an entry, so Back returns
 * to the previous page; closing a page or a link steps back to the entry it opened over (a pack's
 * entry included, so its summary is still there and the next Back leaves it), and only replaces the
 * current entry when nothing in this visit is below it.
 */
export const useRoute = () => {
  const [state, setState] = useState(read);
  const shown = useRef<Shown>({ state: entryState(), route: state.route });

  const sync = useCallback(() => {
    if (unmarked()) {
      // A new entry the browser made: note what it opened over.
      const hash = location.hash;
      const below = shown.current;
      const stamp: EntryState = pageForHash(hash)
        ? pageEntry(below)
        : isLinkHash(hash)
          ? { brainrotLinks: (below.state.brainrotLinks ?? 0) + 1, brainrotRoute: below.route }
          : {};
      history.replaceState(stamp, '');
    }
    const next = read();
    shown.current = { state: entryState(), route: next.route };
    setState((previous) => (same(previous, next) ? previous : next));
    routeShown();
  }, []);

  useEffect(() => {
    // Mark the entry the visit started on, so a link opened over it later can tell it apart from a new one.
    if (unmarked()) history.replaceState({}, '');
    const note = () => { shown.current = { state: entryState(), route: routeOf(location.hash, entryState()) }; };
    note();
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    window.addEventListener(HISTORY_ENTRY_EVENT, note);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
      window.removeEventListener(HISTORY_ENTRY_EVENT, note);
    };
  }, [sync]);

  const moved = useCallback(() => {
    // pushState and replaceState don't fire hashchange, which is what diagnostics listen for.
    recordDiagnostic('route-change');
    sync();
  }, [sync]);

  /** Show a page, adding a history entry so Back returns here. Open over a pack's summary steps back to it. */
  const navigate = useCallback((page: Page) => {
    const current = { state: entryState(), route: shown.current.route };
    if (current.route === page) return;
    const depth = current.state.brainrotDepth;
    if (page === 'open' && depth && current.state.brainrotOverPack) {
      history.go(-depth);
      return;
    }
    history.pushState(page === 'open' ? {} : pageEntry(current), '', appPath() + pageHash(page));
    moved();
  }, [moved]);

  /** Close the page showing: back to the Open entry it was opened over, or swapped for Open in place. */
  const closePage = useCallback(() => {
    const depth = entryState().brainrotDepth;
    if (depth) {
      history.go(-depth);
      return;
    }
    history.replaceState({}, '', appPath());
    moved();
  }, [moved]);

  /** Close a shared link's viewer: back to the entry it opened over (a pack's included), or swapped for that page. */
  const closeLink = useCallback(() => {
    const current = entryState();
    const { route } = shown.current;
    if (current.brainrotLinks) {
      history.go(-current.brainrotLinks);
      return;
    }
    history.replaceState({}, '', appPath() + pageHash(route));
    moved();
  }, [moved]);

  return { ...state, navigate, closePage, closeLink };
};
