// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import { mountedApp } from './mountedApp';

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
    screen = { default: ({ onClose }) => createElement(Sheet, { title: 'Loaded screen', onClose, children: 'Real Sheet content' }) };
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

it('contains an import rejection and retries with a new request without losing the Sheet focus', async () => {
  const fixture = await setup();
  await app!.interact(() => { button('Open screen').focus(); button('Open screen').click(); });
  // StrictMode starts two subscriptions; both observe this same controlled import outcome.
  await app!.interact(() => { fixture.initial.reject(new Error('connection failed')); });
  await app!.until('an import failure has actionable feedback', () => expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load Example"));
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
  for (const [target, content] of [['Collection', '.collection'], ['Profile', '.pulls-page'], ['Achievements', '.achievements'], ['Settings', '.settings-group']]) {
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
