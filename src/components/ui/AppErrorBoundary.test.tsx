// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBrowserDiagnosticCapture } from '../../game/diagnostics';
import AppErrorBoundary from './AppErrorBoundary';

const diagnosticsFault = vi.hoisted(() => ({ throws: false }));
vi.mock('../../game/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../game/diagnostics')>();
  return {
    ...actual,
    recordDiagnostic: (...args: Parameters<typeof actual.recordDiagnostic>) => {
      if (diagnosticsFault.throws) throw new Error('diagnostics broke');
      actual.recordDiagnostic(...args);
    },
  };
});

const SECRET = 'PRIVATE_CRASH_DETAIL secretKey=0101 name=Somebody';

function Thrower(): never {
  throw new Error(SECRET);
}

describe('app error boundary', () => {
  let container: HTMLDivElement;
  let root: Root;
  let reload: ReturnType<typeof vi.fn<() => void>>;
  let consoleError: { mockRestore: () => void };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // React reports caught errors to the console; keep the test output clean.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.clear();
    sessionStorage.clear();
    reload = vi.fn<() => void>();
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setBrowserDiagnosticCapture(false);
    diagnosticsFault.throws = false;
    consoleError.mockRestore();
    Reflect.deleteProperty(navigator, 'clipboard');
    vi.unstubAllGlobals();
  });

  const crash = () => act(() => root.render(<AppErrorBoundary reload={reload}><Thrower /></AppErrorBoundary>));
  const button = (name: string) => [...container.querySelectorAll('button')].find((el) => el.textContent === name)!;

  it('renders children until one throws, then a small fallback', () => {
    act(() => root.render(<AppErrorBoundary reload={reload}><p>Pack ready</p></AppErrorBoundary>));
    expect(container.textContent).toBe('Pack ready');

    crash();
    const heading = container.querySelector('h1')!;
    expect(heading.textContent).toBe('Something went wrong');
    expect(document.activeElement).toBe(heading);
    expect(container.querySelector('main')!.getAttribute('aria-labelledby')).toBe(heading.id);
  });

  it('reloads only when the player presses Reload', () => {
    crash();
    const control = button('Reload');
    expect(control.type).toBe('button');
    expect(reload).not.toHaveBeenCalled();
    act(() => control.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('offers a sanitized report without the thrown message or stack', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    crash();
    const textarea = container.querySelector<HTMLTextAreaElement>('#app-crash-report-text')!;
    expect(textarea.closest('details')!.querySelector('summary')!.textContent).toBe('Show bug report');
    expect(textarea.readOnly).toBe(true);
    const report = JSON.parse(textarea.value);
    expect(Object.keys(report).sort()).toEqual(['browser', 'build', 'captureEnabled', 'connection', 'connectivity', 'device', 'events', 'format', 'route', 'viewport']);
    expect(container.innerHTML).not.toMatch(/PRIVATE_CRASH_DETAIL|secretKey|Somebody|Thrower|at \w+ \(/);

    await act(async () => button('Copy report').click());
    expect(writeText).toHaveBeenCalledWith(textarea.value);
    expect(container.querySelector('[role="status"]')!.textContent).toBe('Copied the report. Nothing was uploaded.');
    const link = container.querySelector('a')!;
    expect(link.href).toMatch(/^https:\/\/github\.com\/.+\/issues\/new\?template=bug\.yml$/);
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('shows and copies the render-error category only when capture is opted in', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const reportText = () => container.querySelector<HTMLTextAreaElement>('#app-crash-report-text')!.value;

    crash();
    expect(JSON.parse(reportText()).events).toEqual([]);
    act(() => root.unmount());

    setBrowserDiagnosticCapture(true);
    root = createRoot(container);
    crash();
    expect(JSON.parse(reportText()).events).toEqual([{ step: 1, event: 'render-error' }]);
    expect(reportText()).not.toContain(SECRET);
    await act(async () => button('Copy report').click());
    expect(JSON.parse(writeText.mock.calls[0][0]).events).toEqual([{ step: 1, event: 'render-error' }]);
  });

  it('still shows the fallback when diagnostics throw', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('blocked'); } }, configurable: true });
    setBrowserDiagnosticCapture(true);
    diagnosticsFault.throws = true;
    crash();
    expect(container.querySelector('h1')!.textContent).toBe('Something went wrong');
    expect(JSON.parse(container.querySelector<HTMLTextAreaElement>('#app-crash-report-text')!.value).events).toEqual([]);

    await act(async () => button('Copy report').click());
    expect(container.querySelector('[role="status"]')!.textContent).toMatch(/^Copy was blocked\./);
  });

  it('never touches storage while showing the fallback', () => {
    localStorage.setItem('kept', 'yes');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const clear = vi.spyOn(Storage.prototype, 'clear');
    crash();
    act(() => button('Reload').click());
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(localStorage.getItem('kept')).toBe('yes');
    setItem.mockRestore();
    removeItem.mockRestore();
    clear.mockRestore();
  });
});
