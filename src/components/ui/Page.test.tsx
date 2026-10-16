// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Page, { type PageSection } from './Page';
import { sheetLoader } from './sheetEntry';

vi.mock('../../game/reload', () => ({ reloadPage: vi.fn() }));

type ScreenProps = { label: string };
const Screen = ({ label }: ScreenProps) => (
  <div>
    <p>{label}</p>
    <section id="extra"><h2 tabIndex={-1}>Extra</h2></section>
  </div>
);

let root: Root;
let container: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn<() => void>>;

const render = (element: ReactElement) => act(() => root.render(element));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const deferred = () => {
  let resolve!: (value: { default: typeof Screen }) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ default: typeof Screen }>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onClose = vi.fn<() => void>();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Page', () => {
  it('holds the page with a skeleton of rows while its chunk loads, then shows the screen', async () => {
    const chunk = deferred();
    const load = sheetLoader(() => chunk.promise);
    render(<Page load={load} title="Rankings" skeleton="rows" screenProps={{ label: 'loaded' }} onClose={onClose} />);

    expect(container.querySelector('main h1')?.textContent).toBe('Rankings');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading Rankings');
    expect(container.querySelectorAll('.page-skeleton--rows .page-skeleton-item')).toHaveLength(8);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    chunk.resolve({ default: Screen });
    await flush();
    expect(container.textContent).toContain('loaded');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('shows a page whose chunk already arrived straight away, with no skeleton', async () => {
    const load = sheetLoader(() => Promise.resolve({ default: Screen }));
    await load();
    render(<Page load={load} title="Cards" screenProps={{ label: 'ready' }} onClose={onClose} />);
    expect(container.textContent).toContain('ready');
    expect(container.querySelector('.page-skeleton')).toBeNull();
  });

  it('offers Reload and Retry when the chunk fails, and Retry loads it again', async () => {
    let attempts = 0;
    const load = sheetLoader(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ default: Screen });
    });
    render(<Page load={load} title="Settings" screenProps={{ label: 'second try' }} onClose={onClose} />);
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load Settings");

    const retry = [...container.querySelectorAll('button')].find((el) => el.textContent === 'Retry')!;
    await act(async () => retry.click());
    await flush();
    expect(attempts).toBe(2);
    expect(container.textContent).toContain('second try');
  });

  it('closes from its labelled close button', () => {
    const load = sheetLoader(() => Promise.resolve({ default: Screen }));
    render(<Page load={load} title="Profile" screenProps={{ label: '' }} onClose={onClose} />);
    container.querySelector<HTMLButtonElement>('[aria-label="Close Profile"]')!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus to its heading only when opened from inside the app', () => {
    const load = sheetLoader(() => new Promise<never>(() => {}));
    render(<Page load={load} title="Cards" screenProps={{ label: '' }} onClose={onClose} />);
    expect(document.activeElement).toBe(document.body);
    act(() => root.unmount());

    root = createRoot(container);
    render(<Page load={load} title="Cards" screenProps={{ label: '' }} onClose={onClose} autoFocus />);
    expect(document.activeElement).toBe(container.querySelector('h1'));
  });

  it('brings a requested section into view once loaded, and again when asked again', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const load = sheetLoader(() => Promise.resolve({ default: Screen }));
    const page = (section: PageSection) => <Page load={load} title="Settings" section={section} screenProps={{ label: '' }} onClose={onClose} />;

    render(page({ id: 'extra', n: 1 }));
    await flush();
    expect(document.activeElement?.textContent).toBe('Extra');
    expect(scroll).toHaveBeenCalledTimes(1);

    (document.activeElement as HTMLElement).blur();
    render(page({ id: 'extra', n: 2 }));
    expect(document.activeElement?.textContent).toBe('Extra');
    expect(scroll).toHaveBeenCalledTimes(2);
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });
});
