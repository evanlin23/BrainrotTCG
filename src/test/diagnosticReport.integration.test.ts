// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => {
  const diagnostics = await import('../game/diagnostics');
  diagnostics.setBrowserDiagnosticCapture(false);
  // jsdom has neither; tests define them on the navigator instance.
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(navigator, 'sendBeacon');
  await app?.dispose();
  app = undefined;
});
const button = (text: string) => {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => (element.getAttribute('aria-label') ?? element.textContent) === text);
  expect(node, text).toBeDefined();
  return node!;
};

it('previews only sanitized fields, captures optionally, edits and handles clipboard failure without uploading', async () => {
  app = await mountedApp({});
  await app.mount(async () => {
    const { createElement } = await import('react');
    const { default: DiagnosticReport } = await import('../components/ui/DiagnosticReport');
    return { default: () => createElement(DiagnosticReport, { onClose() {} }) };
  });
  const diagnostics = await import('../game/diagnostics');
  const text = document.querySelector('textarea')!;
  expect(JSON.parse(text.value).captureEnabled).toBe(false);
  expect(document.body.textContent).toContain('Event capture is off');
  localStorage.setItem('brainrot-player-v1', 'PRIVATE_KEY_NEVER_SHARE');
  history.replaceState(null, '', '#/pull/PRIVATE_PROOF_NEVER_SHARE');
  await app.interact(() => button('Refresh details').click());
  expect(text.value).not.toContain('PRIVATE_');
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await app.interact(() => checkbox.click());
  expect(document.body.textContent).not.toContain('Event capture is off');
  window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE_KEY_NEVER_SHARE' }));
  await app.interact(() => button('Refresh details').click());
  expect(JSON.parse(text.value).events).toEqual([{ step: 1, event: 'unhandled-error' }]);
  expect(text.value).not.toContain('PRIVATE_');
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await app.interact(() => { nativeSet.call(text, 'Reviewed report'); text.dispatchEvent(new Event('input', { bubbles: true })); });
  const writeText = vi.fn().mockRejectedValue(new Error('PRIVATE_CLIPBOARD_ERROR'));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await app.interact(() => button('Copy report').click());
  expect(writeText).toHaveBeenCalledWith('Reviewed report');
  expect(document.body.textContent).toContain('Copy was blocked');
  expect(document.body.textContent).not.toContain('PRIVATE_');
  writeText.mockResolvedValue(undefined);
  await app.interact(() => button('Copy report').click());
  expect(document.body.textContent).toContain('Copied the report');
  const link = document.querySelector<HTMLAnchorElement>('a')!;
  expect(link.href).toBe('https://github.com/evanlin23/BrainrotTCG/issues/new?template=bug.yml');
  expect(link.target).toBe('_blank');
  expect(link.rel).toContain('noopener');
  await app.interact(() => button('Clear recorded steps').click());
  expect(diagnostics.diagnosticSnapshot({}).events).toEqual([]);
  await app.interact(() => checkbox.click());
  expect(diagnostics.isDiagnosticCaptureEnabled()).toBe(false);
  diagnostics.setBrowserDiagnosticCapture(false);
});

it('opens from the real Sound & display screen as a labelled dialog that never touches the network', async () => {
  app = await mountedApp({
    'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Diagnostics fixture', nextNonce: 0, createdAt: 1 }),
    'brainrot-settings-v1': JSON.stringify({ musicVolume: 0, effectsVolume: 0 }),
  });
  await app.mount();
  await app.interact(() => { button('Sound & display').focus(); button('Sound & display').click(); });
  await app.until('Sound & display loads', () => expect(document.querySelector('[role="dialog"] .settings-group')).not.toBeNull());

  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
  const send = vi.spyOn(XMLHttpRequest.prototype, 'send');
  open.mockClear();
  send.mockClear();
  const sendBeacon = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

  const opener = button('Report a problem');
  await app.interact(() => { opener.focus(); opener.click(); });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"].diagnostic-report')!;
  expect(dialog).not.toBeNull();
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Report a problem');
  const text = dialog.querySelector('textarea')!;
  expect(JSON.parse(text.value).captureEnabled).toBe(false);
  expect(dialog.textContent).toContain('Event capture is off, so this report has no recent events.');

  // A hash with a query is reduced to a coarse route category.
  history.replaceState(null, '', '#/x?secret=1');
  await app.interact(() => button('Refresh details').click());
  expect(JSON.parse(text.value).route).toBe('other');
  expect(text.value).not.toContain('secret');

  await app.interact(() => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(JSON.parse(text.value)).toMatchObject({ captureEnabled: true, events: [] });
  expect(dialog.textContent).not.toContain('Event capture is off');
  await app.interact(() => button('Copy report').click());
  expect(writeText).toHaveBeenCalledWith(text.value);
  expect(writeText.mock.calls[0][0]).not.toContain('secret');
  expect(dialog.textContent).toContain('Copied the report');

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(sendBeacon).not.toHaveBeenCalled();

  // Escape closes only the report and hands focus back to its opener inside Settings.
  await app.interact(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('.diagnostic-report')).toBeNull();
  expect(document.querySelector('[role="dialog"] .settings-group')).not.toBeNull();
  expect(document.activeElement).toBe(button('Report a problem'));
});
