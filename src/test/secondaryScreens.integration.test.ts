// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { getSetCards } from '../data/cards';
import { isOpenable, SETS } from '../content/sets';
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => {
  const current = app;
  app = undefined;
  await current?.dispose();
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const button = (text: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === text);
  expect(found, `button ${text}`).toBeDefined();
  return found!;
};

async function setup() {
  type Screen = { default: ComponentType<{ onClose: () => void }> };
  const initial = deferred<Screen>();
  const load = vi.fn().mockReturnValue(initial.promise);
  app = await mountedApp({});
  let screen!: Screen;
  await app.mount(async () => {
    const { createElement, useState } = await import('react');
    const { default: Sheet } = await import('../components/ui/Sheet');
    const { default: DeferredSheet } = await import('../components/ui/DeferredSheet');
    const Screen = ({ onClose }: { onClose: () => void }) => {
      const [nested, setNested] = useState(false);
      return createElement(Sheet, { title: 'Loaded screen', onClose, children: [
        'Real Sheet content',
        createElement('button', { key: 'more', onClick: () => setNested(true) }, 'Open nested'),
        nested && createElement(Sheet, { key: 'nested', title: 'Nested', onClose: () => setNested(false), children: 'Nested content' }),
      ] });
    };
    screen = { default: Screen };
    const Root = () => {
      const [open, setOpen] = useState(false);
      return createElement('div', null,
        createElement('button', { onClick: () => setOpen(true) }, 'Open screen'),
        open && createElement(DeferredSheet, { title: 'Example', load, screenProps: { onClose: () => setOpen(false) } }),
      );
    };
    return { default: Root };
  });
  return { initial, load, get screen() { return screen; } };
}

it('loads on demand, keeps loading dismissible, retires closed results and restores opener focus', async () => {
  const fixture = await setup();
  expect(fixture.load).not.toHaveBeenCalled();
  await app!.interact(() => { button('Open screen').focus(); button('Open screen').click(); });
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading Example…');
  expect(document.activeElement?.getAttribute('role')).toBe('dialog');
  await app!.interact(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(button('Open screen'));
  await app!.interact(() => { fixture.initial.resolve(fixture.screen); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await app!.interact(() => button('Open screen').click());
  await app!.until('reopening loads the requested real Sheet', () => expect(document.body.textContent).toContain('Real Sheet content'));
  await app!.interact(() => button('Close').click());
  expect(document.activeElement).toBe(button('Open screen'));
});

it('enters once: a screen arriving after its placeholder is on screen takes its place in place', async () => {
  const fixture = await setup();
  const root = (text: string) => [...document.querySelectorAll('.sheet-root')].find((el) => el.textContent?.includes(text))!;
  await app!.interact(() => { button('Open screen').focus(); button('Open screen').click(); });
  await app!.settle(50); // the placeholder has reached the screen and started its entrance
  expect(root('Loading Example').classList).not.toContain('sheet-root--settled');
  await app!.interact(() => fixture.initial.resolve(fixture.screen));
  await app!.until('the loaded screen replaces the placeholder', () => expect(document.body.textContent).toContain('Real Sheet content'));
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(root('Real Sheet content').classList).toContain('sheet-root--settled');
  expect(document.activeElement?.getAttribute('role')).toBe('dialog');
  // A sheet the screen opens later plays its own entrance.
  await app!.interact(() => button('Open nested').click());
  expect(root('Nested content').classList).not.toContain('sheet-root--settled');
  await app!.interact(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await app!.interact(() => button('Close').click());
  expect(document.activeElement).toBe(button('Open screen'));
  // Arriving before the placeholder's first frame, the screen makes the entrance itself.
  await app!.interact(() => button('Open screen').click());
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(root('Real Sheet content').classList).not.toContain('sheet-root--settled');
});

it('contains an import rejection and retries with a new request without losing the Sheet focus', async () => {
  const fixture = await setup();
  await app!.interact(() => { button('Open screen').focus(); button('Open screen').click(); });
  // StrictMode starts two subscriptions; both observe this same controlled import outcome.
  await app!.interact(() => { fixture.initial.reject(new Error('connection failed')); });
  await app!.until('an import failure has actionable feedback', () => expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load Example"));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('probably updated');
  // A stale chunk after a deploy only comes back with a reload; saves live in storage, so it is safe.
  const reload = vi.spyOn(await import('../game/reload'), 'reloadPage').mockImplementation(() => {});
  await app!.interact(() => button('Reload').click());
  expect(reload).toHaveBeenCalledOnce();
  const recovered = deferred<typeof fixture.screen>();
  const previousCalls = fixture.load.mock.calls.length;
  fixture.load.mockReturnValue(recovered.promise);
  await app!.interact(() => { button('Retry').focus(); button('Retry').click(); });
  expect(fixture.load.mock.calls.length).toBeGreaterThan(previousCalls);
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  expect(document.activeElement?.getAttribute('role')).toBe('dialog');
  await app!.interact(() => recovered.resolve(fixture.screen));
  await app!.until('a fresh import succeeds after failure', () => expect(document.body.textContent).toContain('Real Sheet content'));
  await app!.interact(() => button('Close').click());
  expect(document.activeElement).toBe(button('Open screen'));
});

it('keeps actual App secondary navigation working without changing the selected pack', async () => {
  app = await mountedApp({
    'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Deferred screens fixture', nextNonce: 0, createdAt: 1 }),
    'brainrot-settings-v1': JSON.stringify({ musicVolume: 0, effectsVolume: 0 }),
  });
  await app.mount();
  const pack = document.querySelector('[aria-label^="Open a "]')?.getAttribute('aria-label');
  for (const [target, content] of [['My cards', '.collection'], ['Player', '.settings-group'], ['Sound & display', '.settings-group']]) {
    await app.interact(() => { button(target).focus(); button(target).click(); });
    await app.until(`${target} loads its production controls`, () => {
      expect(document.querySelector(`[role="dialog"]${content}, [role="dialog"] ${content}`)).not.toBeNull();
      expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
    });
    await app.interact(() => button('Close').click());
    expect(document.activeElement).toBe(button(target));
    expect(document.querySelector('[aria-label^="Open a "]')?.getAttribute('aria-label')).toBe(pack);
  }
});

it('opens the era of the selected pack first in My cards', async () => {
  // One card each of the oldest openable era (the selected pack) and the two newest, from the registry
  // the app reads, so a new set moves the fixture with it. Without the selected era, the collection
  // would open the two newest and leave the selected one collapsed.
  const openable = SETS.filter(isOpenable);
  const [selected, secondNewest, newest] = [openable[0], ...openable.slice(-2)];
  expect(new Set([selected.id, secondNewest.id, newest.id]).size).toBe(3);
  // The 24-pocket budget the sheet opens with fits the selected and newest eras, not a third.
  const pockets = (set: { id: string }) => getSetCards(set.id).length;
  expect(pockets(selected) + pockets(newest)).toBeLessThanOrEqual(24);
  expect(pockets(selected) + pockets(newest) + pockets(secondNewest)).toBeGreaterThan(24);
  const cards = [selected, secondNewest, newest].map((set) => getSetCards(set.id)[0]);
  app = await mountedApp({
    'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Selected era fixture', nextNonce: 0, createdAt: 1 }),
    'brainrot-settings-v1': JSON.stringify({ musicVolume: 0, effectsVolume: 0 }),
    [STORAGE_KEYS.SELECTED_SET]: selected.id,
    [STORAGE_KEYS.COLLECTION]: JSON.stringify(Object.fromEntries(cards.map((card) => [card.key, { card, normalCount: 1, holoCount: 0 }]))),
    [DATA_VERSION_KEY]: String(CURRENT_DATA_VERSION),
  });
  await app.mount();
  const headers = () => [...document.querySelectorAll('[role="dialog"].collection .collection-set-toggle')];
  await app.interact(() => button('My cards').click());
  await app.until('the real collection loads under My cards', () => expect(headers()).toHaveLength(3));
  const open = headers().filter((h) => h.getAttribute('aria-expanded') === 'true').map((h) => h.querySelector('.collection-set-name')?.textContent);
  expect(open).toEqual([selected.name, newest.name]);
});

// The App's own Rankings, Best pulls (titled "My cards", like the collection) and Share sheets, through
// the real DeferredSheet. Each loader stands in for a chunk a deploy removed while `stale` holds its title,
// then resolves a stub screen in the real Sheet that records the props the App passed. The collection
// shares the "My cards" title but has no stats, so it loads for real. (Mocking the screen modules themselves is
// unreliable here: vitest serves StrictMode's second concurrent import() the unmocked module.)
type StubProps = Record<string, unknown> & { onClose: () => void };
type Loader = () => Promise<{ default: ComponentType<StubProps> }>;
type Wrapped = { title: string; size?: string; load: Loader; screenProps: StubProps };
const lazyScreens = { Rankings: '../components/pages/HallOfFamePage', 'My cards': '../components/profile/MyProfilePage', 'Share your pull': '../components/share/ShareSheet' };
type Title = keyof typeof lazyScreens;
type Seen = { appLoad: Loader; load: Loader; calls: number; size?: string; props?: StubProps };
afterEach(() => { vi.doUnmock('../components/ui/DeferredSheet'); });

it('mounts the App Rankings, Best pulls and Share sheets through DeferredSheet and recovers them from a stale chunk', async () => {
  const stale = new Set(Object.keys(lazyScreens));
  const seen: Partial<Record<Title, Seen>> = {};
  vi.doMock('../components/ui/DeferredSheet', async (importOriginal) => {
    const { createElement } = await import('react');
    const { default: Sheet } = await import('../components/ui/Sheet');
    const DeferredSheet = (await importOriginal<{ default: ComponentType<Wrapped> }>()).default;
    const stub = (title: Title) => (props: StubProps) => {
      seen[title]!.props = props;
      const share = title === 'My cards' && createElement('button', {
        key: 'share',
        type: 'button',
        onClick: () => (props.onSharePull as (entry: object, cards: []) => void)({ setId: 'stub-set', setVersion: 1, nonce: 7, key: 'ab'.repeat(32) }, []),
      }, 'Share stub pull');
      return createElement(Sheet, { title: `${title} screen`, onClose: props.onClose, children: [`${title} loaded`, share] as ReactNode });
    };
    const Wrapper = (props: Wrapped) => {
      if (!(props.title in lazyScreens) || (props.title === 'My cards' && !('stats' in props.screenProps))) return createElement(DeferredSheet, props);
      const title = props.title as Title;
      const entry: Seen = seen[title] ??= {
        appLoad: props.load,
        calls: 0,
        load: async () => {
          entry.calls += 1;
          if (stale.has(title)) throw new TypeError('Failed to fetch dynamically imported module');
          return { default: stub(title) };
        },
      };
      entry.size = props.size;
      return createElement(DeferredSheet, { ...props, load: entry.load });
    };
    return { default: Wrapper };
  });
  app = await mountedApp({
    'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Stale chunk fixture', nextNonce: 0, createdAt: 1 }),
    'brainrot-settings-v1': JSON.stringify({ musicVolume: 0, effectsVolume: 0 }),
  });
  await app.mount();
  const reload = vi.spyOn(await import('../game/reload'), 'reloadPage').mockImplementation(() => {});

  const recover = async (title: Title, open: () => void) => {
    expect(seen[title], `${title} is not mounted before it is requested`).toBeUndefined();
    await app!.interact(open);
    await app!.until(`${title} explains a failed chunk`, () => expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(`Couldn't load ${title}`));
    const size = title === 'Share your pull' ? 'md' : 'lg';
    expect(seen[title]!.size ?? 'md').toBe(size);
    expect(document.querySelector('[role="dialog"] [role="alert"]')!.closest('.sheet-root')!.classList).toContain(`sheet-root--${size}`);
    const saved = JSON.stringify(Object.entries(localStorage));
    await app!.interact(() => button('Reload').click());
    expect(reload).toHaveBeenCalledOnce();
    expect(JSON.stringify(Object.entries(localStorage)), 'reload clears nothing').toBe(saved);
    reload.mockClear();
    stale.delete(title);
    const failed = seen[title]!.calls;
    await app!.interact(() => button('Retry').click());
    await app!.until(`${title} loads on retry`, () => expect(document.body.textContent).toContain(`${title} loaded`));
    expect(seen[title]!.calls, `${title} retry requests the chunk again`).toBeGreaterThan(failed);
    expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
    // The App's own loader resolves the production screen.
    const real = await import(/* @vite-ignore */ lazyScreens[title]) as { default: unknown };
    expect((await seen[title]!.appLoad()).default).toBe(real.default);
  };

  await recover('Rankings', () => { button('Rankings').focus(); button('Rankings').click(); });
  await app.interact(() => button('Close').click());
  expect(document.activeElement).toBe(button('Rankings'));

  await app.interact(() => button('My cards').click());
  await app.until('the real collection loads under My cards', () => expect(document.querySelector('[role="dialog"].collection')).not.toBeNull());
  await recover('My cards', () => button('Best pulls').click());
  await recover('Share your pull', () => button('Share stub pull').click());
  expect(seen['Share your pull']!.props?.target).toMatchObject({ ref: { setId: 'stub-set', setVersion: 1, nonce: 7, publicKeyHex: 'ab'.repeat(32) }, cards: [] });
});
