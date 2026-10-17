// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETS } from '../content/sets';
import type { SetDefinition } from '../engine';
import { useSetLink } from './useSetLink';

const released = SETS.find((s) => !s.draft && !s.archivedAt)!;
const draft: SetDefinition = { ...released, id: 'draft-preview', draft: true };
const archived: SetDefinition = { ...released, id: 'old-archive', archivedAt: '2020-01-01' };
const sets = [released, draft, archived];

let root: Root | undefined;
const Harness = ({ busy, select }: { busy: boolean; select: (id: string) => void }) => {
  useSetLink(sets, busy, select);
  return null;
};
const mount = (busy: boolean, select: (id: string) => void) => {
  root = createRoot(document.createElement('div'));
  act(() => root!.render(<Harness busy={busy} select={select} />));
};
// What a browser does when an address that differs only in its hash is typed over the page.
const typeHash = (hash: string) => {
  history.pushState(null, '', `${location.pathname}${location.search}${hash}`);
  act(() => {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  history.replaceState(null, '', '/');
});

describe('useSetLink', () => {
  it('opens on the linked set when the app loads on its link, and drops the hash from that entry', () => {
    history.replaceState(null, '', `/#/set/${released.id}`);
    const length = history.length;
    const select = vi.fn();
    mount(false, select);
    expect(select).toHaveBeenCalledWith(released.id);
    expect(location.hash).toBe('');
    expect(history.length).toBe(length);
  });

  it('keeps the hash on the entry the browser added for a link typed over the app, so Back still moves', () => {
    const select = vi.fn();
    mount(false, select);
    const length = history.length;
    typeHash(`#/set/${released.id}`);
    expect(select).toHaveBeenCalledWith(released.id);
    // One new entry, not a copy of the plain Open entry below it.
    expect(history.length).toBe(length + 1);
    expect(location.hash).toBe(`#/set/${released.id}`);
  });

  it('ignores the link while a pack is open', () => {
    history.replaceState(null, '', `/#/set/${released.id}`);
    const select = vi.fn();
    mount(true, select);
    typeHash(`#/set/${released.id}`);
    expect(select).not.toHaveBeenCalled();
  });

  it.each([
    ['a draft set', draft.id],
    ['an archived set', archived.id],
    ['a set that is not there', 'no-such-set'],
  ])('ignores a link to %s', (_, id) => {
    history.replaceState(null, '', `/#/set/${id}`);
    const select = vi.fn();
    mount(false, select);
    typeHash(`#/set/${id}`);
    expect(select).not.toHaveBeenCalled();
  });

  it('leaves other hashes alone', () => {
    history.replaceState(null, '', '/#/cards');
    const select = vi.fn();
    mount(false, select);
    expect(select).not.toHaveBeenCalled();
    expect(location.hash).toBe('#/cards');
  });
});
