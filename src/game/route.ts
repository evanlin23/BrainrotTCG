/**
 * The app's pages, one per hash route. Opening packs is the default: no hash at all. Shared links
 * (#/pull/<proof>, #/profile/<id>) aren't pages: they open a viewer sheet over whichever page is showing.
 */
export type Page = 'open' | 'cards' | 'rankings' | 'profile' | 'settings' | 'news';

const PAGES: ReadonlyMap<string, Exclude<Page, 'open'>> = new Map([
  ['#/cards', 'cards'],
  ['#/rankings', 'rankings'],
  ['#/profile', 'profile'],
  ['#/settings', 'settings'],
  ['#/news', 'news'],
]);

/** The page a hash names, matched exactly (`#/profile/<id>` is a shared profile, not your own). */
export const pageForHash = (hash: string): Exclude<Page, 'open'> | null => PAGES.get(hash) ?? null;

/** The hash that opens a page; Open has none. */
export const pageHash = (page: Page) => (page === 'open' ? '' : `#/${page}`);

const LINK_HASH = /^#\/(pull|profile)\//;

/** A shared pull or profile link, whole or cut off. */
export const isLinkHash = (hash: string) => LINK_HASH.test(hash);

/** The document title while a page shows; Open keeps the page's own (index.html's). */
export const PAGE_TITLES: Record<Exclude<Page, 'open'>, string> = {
  cards: 'Cards - Brainrot TCG',
  rankings: 'Rankings - Brainrot TCG',
  profile: 'Profile - Brainrot TCG',
  settings: 'Settings - Brainrot TCG',
  news: "What's new - Brainrot TCG",
};

/** Fired after something else in the app adds a history entry (a pack's), so the route knows what's current. */
export const HISTORY_ENTRY_EVENT = 'brainrot:history-entry';

/** The hash a set's link (s/<set id>/, scripts/preview-pages.ts) opens: Open, with that set chosen. */
export const setLinkHash = (setId: string) => `#/set/${setId}`;

const SET_LINK_HASH = /^#\/set\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;

/** The set a set link names, or null. Set ids are lowercase words joined by '-'. */
export const setIdFromHash = (hash: string): string | null => SET_LINK_HASH.exec(hash)?.[1] ?? null;

/**
 * Every hash the app acts on, as one pattern: a page, a shared link (whole or cut off) or a set's
 * link. It's a RegExp so a page that can't import this module can carry it: the old address after a
 * move (scripts/redirect-site.ts) passes these on and drops anything else.
 */
export const ROUTE_HASH = new RegExp(
  [`^(?:${[...PAGES.keys()].map((hash) => hash.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`, LINK_HASH.source, SET_LINK_HASH.source].join('|'),
);

/** Whether a hash is one the app acts on (ROUTE_HASH). */
export const isRouteHash = (hash: string) => ROUTE_HASH.test(hash);
