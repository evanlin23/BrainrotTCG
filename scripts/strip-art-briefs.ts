import type { Plugin } from 'vite';

/**
 * The set files the browser bundle imports (src/content/sets/index.ts): set.json and the frozen
 * set.v<N>.json copies of released versions.
 */
export const SET_FILE = /[\\/]src[\\/]content[\\/]sets[\\/][^\\/]+[\\/]set(?:\.v\d+)?\.json$/;

/**
 * A set file's JSON without each card's `art` (the brief for the SVG art and Gemini prompts,
 * src/engine/types.ts). Nothing in the browser reads it, and it is about a third of every set's
 * bytes; the card builds, previews, set locks and the verifier read the files on disk instead.
 */
export const stripArtBriefs = (json: string): string => {
  const set = JSON.parse(json) as { cards?: Record<string, unknown>[] };
  if (!Array.isArray(set.cards)) throw new Error('strip-art-briefs: a set file has no cards array');
  return JSON.stringify({ ...set, cards: set.cards.map(({ art: _art, ...card }) => card) });
};

/**
 * Drops card art briefs from the set data in the production bundle (#1365). Build only: the dev
 * server and Vitest keep the files as written, and the files themselves are never changed.
 */
export const artBriefStripper = (): Plugin => {
  let stripped = 0;
  return {
    name: 'strip-art-briefs',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!SET_FILE.test(id.replace(/[?#].*$/, ''))) return null;
      stripped += 1;
      return stripArtBriefs(code);
    },
    buildEnd(error) {
      if (!error && stripped === 0) throw new Error("strip-art-briefs: no set file was transformed; update SET_FILE in scripts/strip-art-briefs.ts");
    },
  };
};
