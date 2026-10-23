// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyDesignLook, designLookFrom } from './designLook';

describe('draft design looks (#1138)', () => {
  it('reads only the three drafts from ?look=', () => {
    expect(designLookFrom('?look=a')).toBe('a');
    expect(designLookFrom('?set=x&look=c')).toBe('c');
    expect(designLookFrom('?look=d')).toBeUndefined();
    expect(designLookFrom('?look=')).toBeUndefined();
    expect(designLookFrom('')).toBeUndefined();
  });

  it('marks <html> with the look, and clears it when the address names none', () => {
    const root = document.createElement('html');
    applyDesignLook(root, '?look=b');
    expect(root.dataset.look).toBe('b');
    applyDesignLook(root, '?look=nope');
    expect(root.dataset.look).toBeUndefined();
  });
});
