/**
 * The app's pages, one per hash route. Opening packs is the default: no hash at all. Shared links
 * (#/pull/<proof>, #/profile/<id>) aren't pages: they open a viewer sheet over whichever page is showing.
 */
export type Page = 'open' | 'cards' | 'rankings' | 'profile' | 'settings';

const PAGES: ReadonlyMap<string, Exclude<Page, 'open'>> = new Map([
  ['#/cards', 'cards'],
  ['#/rankings', 'rankings'],
  ['#/profile', 'profile'],
  ['#/settings', 'settings'],
]);

/** The page a hash names, matched exactly (`#/profile/<id>` is a shared profile, not your own). */
export const pageForHash = (hash: string): Exclude<Page, 'open'> | null => PAGES.get(hash) ?? null;

/** The hash that opens a page; Open has none. */
export const pageHash = (page: Page) => (page === 'open' ? '' : `#/${page}`);

/** A shared pull or profile link, whole or cut off. */
export const isLinkHash = (hash: string) => /^#\/(pull|profile)\//.test(hash);

/** The document title while a page shows; Open keeps the page's own (index.html's). */
export const PAGE_TITLES: Record<Exclude<Page, 'open'>, string> = {
  cards: 'Cards - Brainrot TCG',
  rankings: 'Rankings - Brainrot TCG',
  profile: 'Profile - Brainrot TCG',
  settings: 'Settings - Brainrot TCG',
};

/** Fired after something else in the app adds a history entry (a pack's), so the route knows what's current. */
export const HISTORY_ENTRY_EVENT = 'brainrot:history-entry';

/** The hash a set's link (s/<set id>/, scripts/preview-pages.ts) opens: Open, with that set chosen. */
export const setLinkHash = (setId: string) => `#/set/${setId}`;

/** The set a set link names, or null. Set ids are lowercase words joined by '-'. */
export const setIdFromHash = (hash: string): string | null => /^#\/set\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(hash)?.[1] ?? null;
