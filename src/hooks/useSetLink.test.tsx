// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETS } from '../content/sets';
import type { SetDefinition } from '../engine';
import { useRoute } from './useRoute';
import { linkedSetAtLoad, useSetLink } from './useSetLink';

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

  it("doesn't mark a link that arrived while a pack was open as followed, so it still applies once the pack is done", () => {
    const select = vi.fn();
    mount(true, select);
    typeHash(`#/set/${released.id}`);
    expect(select).not.toHaveBeenCalled();
    expect(history.state?.brainrotSetLink).toBeFalsy();
    expect(location.hash).toBe(`#/set/${released.id}`);

    // The pack is done, and the player comes back to that entry (Forward, or a Back from a page over it).
    act(() => root!.render(<Harness busy={false} select={select} />));
    act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(released.id);
    expect(history.state?.brainrotSetLink).toBe(true);
  });

  it('applies a link left unmarked by a busy pack when the app reloads on it', () => {
    const select = vi.fn();
    mount(true, select);
    typeHash(`#/set/${released.id}`);
    expect(select).not.toHaveBeenCalled();

    act(() => root?.unmount());
    mount(false, select);
    expect(select).toHaveBeenCalledWith(released.id);
    expect(location.hash).toBe('');
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

describe('useSetLink with the route', () => {
  const other: SetDefinition = { ...released, id: 'other-set' };
  let current: { route: ReturnType<typeof useRoute>; chosen: string; choose: (setId: string) => void };
  const App = () => {
    const route = useRoute();
    const [chosen, choose] = useState('none');
    useSetLink([released, other], false, choose);
    useEffect(() => { current = { route, chosen, choose }; }, [route, chosen]);
    return null;
  };
  // jsdom moves through history a task later: popstate, then hashchange when the hash differs, back to back.
  const nextNavigation = () => act(() => new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener('popstate', done);
      window.removeEventListener('hashchange', done);
      resolve();
    };
    window.addEventListener('popstate', done);
    window.addEventListener('hashchange', done);
  }));
  const settle = async (check: () => boolean) => {
    if (!check()) await nextNavigation();
    expect(check()).toBe(true);
  };

  it("doesn't choose the linked set again over the player's pick when a page opened over its link closes", async () => {
    root = createRoot(document.createElement('div'));
    act(() => root!.render(<App />));
    typeHash(`#/set/${released.id}`);
    expect(current.chosen).toBe(released.id);

    act(() => current.choose(other.id));
    act(() => current.route.navigate('cards'));
    await settle(() => current.route.route === 'cards');
    act(() => current.route.closePage());
    await settle(() => current.route.route === 'open' && location.hash === `#/set/${released.id}`);
    // That step's hashchange fired together with the popstate settled on above, and act has flushed it.
    expect(current.chosen).toBe(other.id);
  });
});

describe('linkedSetAtLoad', () => {
  it('names the released set the address links to, for the first render to start on', () => {
    history.replaceState(null, '', `/#/set/${released.id}`);
    expect(linkedSetAtLoad(sets)).toBe(released.id);
  });

  it('names nothing for no link, an unknown, draft or archived set, or an entry already followed', () => {
    expect(linkedSetAtLoad(sets)).toBeNull();
    for (const id of ['not-a-set', draft.id, archived.id]) {
      history.replaceState(null, '', `/#/set/${id}`);
      expect(linkedSetAtLoad(sets), id).toBeNull();
    }
    history.replaceState({ brainrotSetLink: true }, '', `/#/set/${released.id}`);
    expect(linkedSetAtLoad(sets)).toBeNull();
  });

  it('saves nothing itself: reading it leaves the address and history as they were', () => {
    history.replaceState(null, '', `/#/set/${released.id}`);
    const length = history.length;
    linkedSetAtLoad(sets);
    expect(location.hash).toBe(`#/set/${released.id}`);
    expect(history.length).toBe(length);
  });
});
