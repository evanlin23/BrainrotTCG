// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETS } from '../../content/sets';
import { getCard } from '../../data/cards';
import type { CollectionItem } from '../../types';
import SetPicker from './SetPicker';

const copyText = vi.hoisted(() => vi.fn(async (value: string) => value.length > 0));
vi.mock('../../game/shareActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/shareActions')>()),
  copyText,
}));

const released = SETS.filter((s) => !s.draft && !s.archivedAt);
const set = released[released.length - 1];

let root: Root | undefined;
let host: HTMLElement | undefined;
const render = (sets = released, selectedId = set.id) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SetPicker sets={sets} selectedId={selectedId} onSelect={() => {}} collection={{}} />));
};
const openShelf = () => act(() => document.querySelector<HTMLButtonElement>('.set-current')!.click());
const copyButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Copy link to'));
const status = () => document.querySelector('.pack-shelf-share [role="status"]')!.textContent;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  copyText.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SetPicker set link', () => {
  it("copies the chosen set's own page address and says so", async () => {
    render();
    openShelf();
    const button = copyButton()!;
    expect(button.textContent).toBe(`Copy link to ${set.name}`);
    await act(async () => button.click());
    expect(copyText).toHaveBeenCalledWith(`${location.origin}${import.meta.env.BASE_URL}s/${set.id}/`);
    expect(status()).toBe('Link copied');
  });

  it('stops saying so once another set is chosen, and leaves no timer running after unmount', async () => {
    vi.useFakeTimers();
    const other = released[released.length - 2];
    render();
    openShelf();
    const before = vi.getTimerCount();
    await act(async () => copyButton()!.click());
    expect(status()).toBe('Link copied');
    expect(vi.getTimerCount()).toBe(before + 1);
    act(() => root!.render(<SetPicker sets={released} selectedId={other.id} onSelect={() => {}} collection={{}} />));
    expect(copyButton()!.textContent).toBe(`Copy link to ${other.name}`);
    expect(status()).toBe('');
    act(() => root!.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(before);
  });

  it('clears the message after a moment', async () => {
    vi.useFakeTimers();
    render();
    openShelf();
    await act(async () => copyButton()!.click());
    expect(status()).toBe('Link copied');
    act(() => vi.advanceTimersByTime(1800));
    expect(status()).toBe('');
  });

  it('starts the time over when the same link is copied again', async () => {
    vi.useFakeTimers();
    render();
    openShelf();
    await act(async () => copyButton()!.click());
    act(() => vi.advanceTimersByTime(1200));
    await act(async () => copyButton()!.click());
    act(() => vi.advanceTimersByTime(1200));
    expect(status()).toBe('Link copied');
    act(() => vi.advanceTimersByTime(600));
    expect(status()).toBe('');
  });

  it('offers no link for a draft set, which has no page', () => {
    const draft = { ...set, id: 'draft-preview', draft: true };
    render([...released, draft], draft.id);
    openShelf();
    expect(copyButton()).toBeUndefined();
  });

  it('excludes zero-copy records from set progress', () => {
    const zeroCollection: Record<string, CollectionItem> = Object.fromEntries(
      set.cards.map((c) => {
        const key = `${set.id}/${c.id}`;
        return [key, { card: getCard(key)!, normalCount: 0, holoCount: 0 } satisfies CollectionItem];
      }),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SetPicker sets={released} selectedId={set.id} onSelect={() => {}} collection={zeroCollection} />));
    openShelf();
    const activeTile = document.querySelector('.pack-tile.selected')!;
    expect(activeTile.querySelector('.pack-tile-progress')?.textContent).toContain(`0/${set.cards.length}`);
    expect(activeTile.querySelector('.set-badge')).toBeNull();
  });
});
