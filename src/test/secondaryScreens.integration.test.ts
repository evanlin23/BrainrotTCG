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

it('waits out the rest of the placeholder entrance on a timer before the screen takes its place', async () => {
  // jsdom has no stylesheet, so the entrance is 0ms unless the token is set here.
  document.documentElement.style.setProperty('--dur-slow', '400ms');
  try {
    const fixture = await setup();
    const root = (text: string) => [...document.querySelectorAll('.sheet-root')].find((el) => el.textContent?.includes(text));
    await app!.interact(() => { button('Open screen').focus(); button('Open screen').click(); });
    await app!.settle(100); // the placeholder is on screen, part way through its entrance
    await app!.interact(() => fixture.initial.resolve(fixture.screen));
    await app!.settle(150);
    expect(document.querySelector('[role="status"]')?.textContent, 'the placeholder finishes its entrance').toBe('Loading Example…');
    expect(root('Real Sheet content')).toBeUndefined();
    await app!.until('the screen takes the placeholder\'s place once its entrance ends', () => expect(root('Real Sheet content')).toBeDefined());
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(root('Real Sheet content')!.classList).toContain('sheet-root--settled');
    expect(document.activeElement?.getAttribute('role')).toBe('dialog');
    await app!.interact(() => button('Close').click());
    expect(document.activeElement).toBe(button('Open screen'));
  } finally {
    document.documentElement.style.removeProperty('--dur-slow');
  }
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

const PLAYER = (name: string) => ({
  'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name, nextNonce: 0, createdAt: 1 }),
  'brainrot-settings-v1': JSON.stringify({ effectsVolume: 0 }),
});
/** A player who has saved a pack, so the tabs show (#222). */
const RETURNING = { 'brainrot-stats-v1': JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackValue: 0, highestPackCards: [] }) };
const openShows = () => expect(document.querySelector<HTMLElement>('main.app-main')!.hidden).toBe(false);

it('keeps actual App pages working without changing the selected pack', async () => {
  app = await mountedApp({ ...PLAYER('Pages fixture'), ...RETURNING });
  await app.mount();
  const packName = () => document.querySelector('[data-pack-open]')?.getAttribute('aria-label');
  const pack = packName();
  expect(pack).toMatch(/^Open pack, .+/);
  for (const [target, content] of [['Cards', '.collection'], ['Profile', '#player'], ['Settings', '.settings-group']]) {
    await app.interact(() => { button(target).focus(); button(target).click(); });
    await app.until(`${target} loads its production controls`, () => {
      expect(document.querySelector(`main.page ${content}`)).not.toBeNull();
      expect(document.querySelector('main.page [role="alert"]')).toBeNull();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await app.interact(() => button(`Close ${target}`).click());
    await app.until(`${target} closes to Open`, openShows);
    expect(document.activeElement).toBe(document.querySelector('.app-logo'));
    expect(packName()).toBe(pack);
  }
});

it('opens the era of the selected pack first in Cards', async () => {
  // One card each of the oldest openable era (the selected pack) and the two newest, from the registry
  // the app reads, so a new set moves the fixture with it. Without the selected era, the collection
  // would open the two newest and leave the selected one collapsed.
  const openable = SETS.filter(isOpenable);
  const [selected, secondNewest, newest] = [openable[0], ...openable.slice(-2)];
  expect(new Set([selected.id, secondNewest.id, newest.id]).size).toBe(3);
  // The 24-pocket budget the page opens with fits the selected and newest eras, not a third.
  const pockets = (set: { id: string }) => getSetCards(set.id).length;
  expect(pockets(selected) + pockets(newest)).toBeLessThanOrEqual(24);
  expect(pockets(selected) + pockets(newest) + pockets(secondNewest)).toBeGreaterThan(24);
  const cards = [selected, secondNewest, newest].map((set) => getSetCards(set.id)[0]);
  app = await mountedApp({
    ...PLAYER('Selected era fixture'),
    [STORAGE_KEYS.SELECTED_SET]: selected.id,
    [STORAGE_KEYS.COLLECTION]: JSON.stringify(Object.fromEntries(cards.map((card) => [card.key, { card, normalCount: 1, holoCount: 0 }]))),
    [DATA_VERSION_KEY]: String(CURRENT_DATA_VERSION),
  });
  await app.mount();
  const headers = () => [...document.querySelectorAll('main.page .collection .collection-set-toggle')];
  await app.interact(() => button('Cards').click());
  await app.until('the real collection loads under Cards', () => expect(headers()).toHaveLength(3));
  const open = headers().filter((h) => h.getAttribute('aria-expanded') === 'true').map((h) => h.querySelector('.collection-set-name')?.textContent);
  expect(open).toEqual([selected.name, newest.name]);
});

/** Every lazy screen request the App makes goes through sheetLoader: record which importer ran. */
const recordRequests = () => {
  const requested: string[] = [];
  vi.doMock('../components/ui/sheetEntry', async (importOriginal) => {
    const original = await importOriginal<typeof import('../components/ui/sheetEntry')>();
    return {
      ...original,
      sheetLoader: <M extends { default: unknown }>(importer: () => Promise<M>) =>
        original.sheetLoader(() => { requested.push(String(importer)); return importer(); }),
    };
  });
  return requested;
};

it('fetches the toasts ahead of the first pack: not at startup, once the sealed pack art has settled and the page is idle', async () => {
  const requested = recordRequests();
  // The art's own gate, held shut: StrictMode's effect cleanup in jsdom settles the real one at mount.
  vi.doMock('../game/packArt', () => {
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    const afterPackArt = (task: () => void) => {
      let cancelled = false;
      void settled.then(() => { if (!cancelled) task(); });
      return () => { cancelled = true; };
    };
    return { packArtSettled: () => {}, afterPackArt, releaseArt: release };
  });
  app = await mountedApp({
    ...PLAYER('Warm-up fixture'),
    ...RETURNING,
    [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
    [STORAGE_KEYS.SELECTED_SET]: 'right-now',
  });
  await app.mount();
  await app.until('the pack shell is ready', () => expect(document.querySelector('[data-pack-open]')).not.toBeNull());
  // No toast is due, and the pack's art (which the first screen needs more) has not settled: however long
  // the page idles, the chunk is not asked for.
  await app.settle(5000);
  expect(requested, 'the toasts are not fetched at startup, ahead of the pack art').toEqual([]);

  const { releaseArt } = await import('../game/packArt') as unknown as { releaseArt: () => void };
  await app.interact(() => releaseArt());
  await app.until('the idle page fetches the toasts for the pack to come', () => expect(requested.filter((importer) => importer.includes('AchievementToasts'))).toHaveLength(1));
  expect(requested, 'only the toasts are warmed').toHaveLength(1);
});

it('fetches a page on intent, but not while a pack is opening', async () => {
  const requested = recordRequests();
  app = await mountedApp({
    ...PLAYER('Prefetch fixture'),
    ...RETURNING,
    [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
    [STORAGE_KEYS.SELECTED_SET]: 'right-now',
  }, { tickets: () => ({ delayMs: 4000 }) });
  await app.mount();
  const point = (label: string) => {
    const tab = button(label);
    tab.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    tab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    tab.focus();
  };
  expect(requested, 'nothing is fetched at startup').toEqual([]);
  // The toasts' live region is on the page from the start, so a toast that arrives later is announced.
  expect(document.querySelector('.toast-region[role="status"][aria-live="polite"]')).not.toBeNull();

  await app.until('the pack shell is ready', () => expect(document.querySelector('[data-pack-open]')).not.toBeNull());
  await app.interact(() => {
    // The Open pack button under the pack: the same opening as a finished swipe (#312).
    const open = document.querySelector<HTMLElement>('[data-pack-open]')!;
    expect(open).not.toBeNull();
    open.focus();
    open.click();
  });
  await app.until('a slow ticket holds the app on the pack', () => expect(document.querySelector('.pack-hint.is-waiting')).not.toBeNull());
  expect(button('Settings').disabled).toBe(true);
  await app.interact(() => { point('Cards'); point('Rankings'); });
  await app.settle(100);
  // (The toasts' chunk is warmed once the art settles, which StrictMode does at mount here; it is no page.)
  const pages = () => requested.filter((importer) => !importer.includes('AchievementToasts'));
  expect(pages(), 'no page is fetched while a pack opens').toEqual([]);

  await app.until('the ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await app.interact(() => document.querySelector<HTMLButtonElement>('.reveal-skip')!.click());
  await app.until('the pack lets go of the app', () => expect(button('Settings').disabled).toBe(false));
  // The toasts' chunk is fetched once, however it came to be wanted; no page is until one is pointed at.
  expect(requested.filter((importer) => importer.includes('AchievementToasts'))).toHaveLength(1);
  expect(pages()).toEqual([]);
  await app.interact(() => point('Cards'));
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toContain('CollectionBrowser');
});

// The App's own Rankings and Profile pages, through the real Page, and its Share sheet, through the real
// DeferredSheet. Each loader stands in for a chunk a deploy removed while `stale` holds its title, then
// resolves a stub screen that records the props the App passed. Cards and Settings load for real. (Mocking
// the screen modules themselves is unreliable here: vitest serves StrictMode's second concurrent import()
// the unmocked module.)
type StubProps = Record<string, unknown>;
type Loader = () => Promise<{ default: ComponentType<StubProps> }>;
type Wrapped = { title: string; size?: string; width?: string; skeleton?: string; load: Loader; screenProps: StubProps };
const lazyScreens = { Rankings: '../components/pages/HallOfFamePage', Profile: '../components/profile/ProfilePage', 'Share your pull': '../components/share/ShareSheet' };
type Title = keyof typeof lazyScreens;
type Seen = { appLoad: Loader; load: Loader; calls: number; size?: string; skeleton?: string; props?: StubProps };
afterEach(() => {
  vi.doUnmock('../components/ui/DeferredSheet');
  vi.doUnmock('../components/ui/Page');
  vi.doUnmock('../components/ui/sheetEntry');
  vi.doUnmock('../game/packArt');
});

it('mounts the App Rankings and Profile pages and the Share sheet on demand and recovers them from a stale chunk', async () => {
  const stale = new Set(Object.keys(lazyScreens));
  const seen: Partial<Record<Title, Seen>> = {};
  const track = (title: Title, props: Wrapped) => {
    const entry: Seen = seen[title] ??= {
      appLoad: props.load,
      calls: 0,
      load: async () => {
        entry.calls += 1;
        if (stale.has(title)) throw new TypeError('Failed to fetch dynamically imported module');
        return { default: stub(title) };
      },
    };
    entry.size = props.size ?? props.width;
    entry.skeleton = props.skeleton;
    return entry;
  };
  const { createElement } = await import('react');
  const stub = (title: Title) => (props: StubProps) => {
    seen[title]!.props = props;
    const share = title === 'Profile' && createElement('button', {
      key: 'share',
      type: 'button',
      onClick: () => (props.onSharePull as (entry: object, cards: []) => void)({ setId: 'stub-set', setVersion: 1, nonce: 7, key: 'ab'.repeat(32) }, []),
    }, 'Share stub pull');
    const children = [`${title} loaded`, share] as ReactNode;
    return title === 'Share your pull' ? createElement(SheetStub!, { title: `${title} screen`, onClose: props.onClose as () => void, children }) : createElement('div', null, children);
  };
  let SheetStub: ComponentType<{ title: string; onClose: () => void; children: ReactNode }> | undefined;
  const wrap = (original: ComponentType<Wrapped>) => (props: Wrapped) => {
    if (!(props.title in lazyScreens)) return createElement(original, props);
    return createElement(original, { ...props, load: track(props.title as Title, props).load });
  };
  vi.doMock('../components/ui/DeferredSheet', async (importOriginal) => {
    SheetStub = (await import('../components/ui/Sheet')).default;
    return { default: wrap((await importOriginal<{ default: ComponentType<Wrapped> }>()).default) };
  });
  vi.doMock('../components/ui/Page', async (importOriginal) => {
    const original = await importOriginal<{ default: ComponentType<Wrapped> }>();
    return { ...original, default: wrap(original.default) };
  });
  app = await mountedApp({ ...PLAYER('Stale chunk fixture'), ...RETURNING });
  await app.mount();
  const reload = vi.spyOn(await import('../game/reload'), 'reloadPage').mockImplementation(() => {});

  const recover = async (title: Title, open: () => void) => {
    expect(seen[title], `${title} is not mounted before it is requested`).toBeUndefined();
    await app!.interact(open);
    const sheet = title === 'Share your pull';
    const alert = () => document.querySelector(sheet ? '[role="dialog"] [role="alert"]' : 'main.page [role="alert"]');
    await app!.until(`${title} explains a failed chunk`, () => expect(alert()?.textContent).toContain(`Couldn't load ${title}`));
    if (sheet) {
      expect(seen[title]!.size ?? 'md').toBe('md');
      expect(alert()!.closest('.sheet-root')!.classList).toContain('sheet-root--md');
    } else {
      // A page holds its place in the layout, not in a sheet.
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(alert()!.closest('main.page')!.classList).toContain('page--lg');
    }
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
    expect(alert()).toBeNull();
    // The App's own loader resolves the production screen.
    const real = await import(/* @vite-ignore */ lazyScreens[title]) as { default: unknown };
    expect((await seen[title]!.appLoad()).default).toBe(real.default);
  };

  await recover('Rankings', () => button('Rankings').click());
  // Rankings holds its place with rows, like the list it loads.
  expect(seen.Rankings!.skeleton).toBe('rows');
  await app.interact(() => button('Close Rankings').click());
  await app.until('Rankings closes to Open', openShows);
  expect(document.activeElement).toBe(document.querySelector('.app-logo'));

  await recover('Profile', () => button('Profile').click());
  await recover('Share your pull', () => button('Share stub pull').click());
  expect(seen['Share your pull']!.props?.target).toMatchObject({ ref: { setId: 'stub-set', setVersion: 1, nonce: 7, publicKeyHex: 'ab'.repeat(32) }, cards: [] });
});
