import { describe, expect, it } from 'vitest';
import { SETS } from '../content/sets';
import { setPagePath } from './previewLinks';
import { setIdFromHash, setLinkHash } from './route';

describe('set links', () => {
  it("reads back every set's link, and its page sits at the set's id", () => {
    for (const set of SETS) {
      expect(setIdFromHash(setLinkHash(set.id))).toBe(set.id);
      expect(setPagePath(set.id)).toBe(`s/${set.id}/`);
    }
    expect(setIdFromHash('#/set/right-now/')).toBe('right-now');
  });

  it("isn't fooled by other routes or odd ids", () => {
    for (const hash of ['', '#/open', '#/pull/abc', '#/set/', '#/set/Genesis', '#/set/a/b', '#/set/../x', '#/set/-a', '#/sets/genesis']) {
      expect(setIdFromHash(hash)).toBeNull();
    }
  });
});
