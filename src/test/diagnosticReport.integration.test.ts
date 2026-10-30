// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';

let fakeFrame: typeof requestAnimationFrame;
const onFakeFrame = (callback: FrameRequestCallback) => fakeFrame(callback);

type ReportHarness = {
  unmount: () => Promise<void>;
  dispose: () => void;
};

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
let activeReport: ReportHarness | undefined;

afterEach(async () => {
  const report = activeReport;
  activeReport = undefined;
  const currentApp = app;
  app = undefined;

  try {
    const diagnostics = await import('../game/diagnostics');
    diagnostics.setBrowserDiagnosticCapture(false);
    diagnostics.clearDiagnostics();
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(navigator, 'sendBeacon');

    await report?.unmount();
    report?.dispose();

    await currentApp?.dispose();
  } finally {
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, '', '/BrainrotTCG/');
    document.body.replaceChildren();
    document.body.className = '';
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
/** The text of every element the textarea's aria-describedby names, which must all exist. */
const description = (element: Element) => (element.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  .map((id) => {
    const target = document.getElementById(id);
    expect(target, `aria-describedby target ${id}`).not.toBeNull();
    return target!.textContent;
  }).join(' ');
const button = (text: string) => {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => (element.getAttribute('aria-label') ?? element.textContent) === text);
  expect(node, text).toBeDefined();
  return node!;
};

const mountReport = async (capturing = false) => {
  const errors: string[] = [];
  const blocked = (api: string) => () => {
    const error = `Unexpected external I/O: ${api}`;
    errors.push(error);
    throw new Error(error);
  };

  history.replaceState(null, '', '/BrainrotTCG/');
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  fakeFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = onFakeFrame;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  const fetchSpy = vi.fn(blocked('fetch'));
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('WebSocket', class { constructor() { blocked('WebSocket')(); } });
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(blocked('XMLHttpRequest'));
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('open', blocked('window.open'));
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  if ('sendBeacon' in navigator) vi.spyOn(navigator, 'sendBeacon').mockImplementation(blocked('sendBeacon'));
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(blocked('form.submit'));
  vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(blocked('form.requestSubmit'));
  for (const method of ['error', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(' ')));
  }

  const diagnostics = await import('../game/diagnostics');
  if (capturing) diagnostics.setBrowserDiagnosticCapture(true);

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { default: MotionProvider } = await import('../components/ui/MotionProvider');
  const { default: DiagnosticReport } = await import('../components/ui/DiagnosticReport');

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(MotionProvider, null, React.createElement(DiagnosticReport, { onClose() {} })),
      ),
    );
  });

  const interact = async (action: () => void) => {
    await React.act(async () => action());
  };

  activeReport = {
    unmount: async () => {
      await React.act(async () => root.unmount());
      vi.advanceTimersToNextFrame();
      vi.clearAllTimers();
      document.body.replaceChildren();
      document.body.className = '';
    },
    dispose: () => {
      expect(errors, 'unexpected console errors or external I/O').toEqual([]);
    },
  };

  const text = document.querySelector('textarea')!;
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  const edit = (value: string) => interact(() => { nativeSet.call(text, value); text.dispatchEvent(new Event('input', { bubbles: true })); });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

  return { text, checkbox, edit, writeText, interact, fetchSpy };
};

it('previews only sanitized fields, captures optionally, edits and handles clipboard failure without uploading', async () => {
  const { text, checkbox, edit, interact, fetchSpy } = await mountReport();
  const diagnostics = await import('../game/diagnostics');
  expect(JSON.parse(text.value).captureEnabled).toBe(false);
  expect(document.body.textContent).toContain('Event capture is off');
  expect([...document.querySelectorAll('label')].find((label) => label.htmlFor === text.id)?.textContent).toBe('Report details (editable)');
  expect(description(text)).toContain('Event capture is off');
  expect(description(text)).toContain('rough guesses');
  localStorage.setItem('brainrot-player-v1', 'PRIVATE_KEY_NEVER_SHARE');
  localStorage.setItem('brainrot-collection-recovery-v1', JSON.stringify({ raw: 'PRIVATE_RECOVERY_PAYLOAD', player: '{"secretKey":"PRIVATE_KEY_NEVER_SHARE"}' }));
  history.replaceState(null, '', '#/pull/PRIVATE_PROOF_NEVER_SHARE');
  await interact(() => button('Refresh details').click());
  expect(text.value).not.toContain('PRIVATE_');
  await interact(() => checkbox.click());
  expect(document.body.textContent).not.toContain('Event capture is off');
  expect(description(text)).not.toContain('Event capture is off');
  expect(description(text)).toContain('rough guesses');
  window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE_KEY_NEVER_SHARE' }));
  await interact(() => button('Refresh details').click());
  expect(JSON.parse(text.value).events).toEqual([{ step: 1, event: 'unhandled-error' }]);
  expect(text.value).not.toContain('PRIVATE_');
  await edit('Reviewed report');
  const writeText = vi.fn().mockRejectedValue(new Error('PRIVATE_CLIPBOARD_ERROR'));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await interact(() => button('Copy report').click());
  expect(writeText).toHaveBeenCalledWith('Reviewed report');
  expect(document.body.textContent).toContain('Copy was blocked');
  expect(document.body.textContent).not.toContain('PRIVATE_');
  writeText.mockResolvedValue(undefined);
  await interact(() => button('Copy report').click());
  expect(document.body.textContent).toContain('Copied the report');
  const link = document.querySelector<HTMLAnchorElement>('a')!;
  expect(link.href).toBe('https://github.com/evanlin23/BrainrotTCG/issues/new?template=bug.yml');
  expect(link.target).toBe('_blank');
  expect(link.relList.contains('noopener')).toBe(true);
  expect(link.relList.contains('noreferrer')).toBe(true);
  const note = Array.from(document.querySelectorAll('p')).find((p) => p.textContent!.includes('Posting requires a GitHub account'))!;
  expect(note.textContent).toContain('GitHub requires users to be 13 or older.');
  expect(note.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await interact(() => button('Clear recorded steps').click());
  expect(diagnostics.diagnosticSnapshot({}).events).toEqual([]);
  await interact(() => checkbox.click());
  expect(diagnostics.isDiagnosticCaptureEnabled()).toBe(false);
  diagnostics.setBrowserDiagnosticCapture(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('opens from the real Settings page as a labelled dialog that never touches the network', async () => {
  app = await mountedApp({
    'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Diagnostics fixture', nextNonce: 0, createdAt: 1 }),
    'brainrot-settings-v1': JSON.stringify({ effectsVolume: 0 }),
  });
  await app.mount();
  await app.interact(() => { button('Settings').focus(); button('Settings').click(); });
  await app.until('Settings loads', () => expect(document.querySelector('main.page .settings-group')).not.toBeNull());
  expect(document.querySelector('[role="dialog"]')).toBeNull();

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
  // The page is named from an allowlist, never copied from the address.
  expect(JSON.parse(text.value).route).toBe('settings');

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

  // Escape closes only the report and hands focus back to its opener on the Settings page.
  await app.interact(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('.diagnostic-report')).toBeNull();
  expect(document.querySelector('main.page .settings-group')).not.toBeNull();
  expect(document.activeElement).toBe(button('Report a problem'));
});

it('keeps a reviewed report when capture consent changes, and still removes recorded steps when opting out', async () => {
  const { text, checkbox, edit, writeText, interact } = await mountReport();
  const diagnostics = await import('../game/diagnostics');
  await interact(() => checkbox.click());
  window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE_KEY_NEVER_SHARE' }));
  await interact(() => button('Refresh details').click());
  const recorded = JSON.parse(text.value);
  expect(recorded.events).toEqual([{ step: 1, event: 'unhandled-error' }]);

  // Redact the route and add a note, then opt out: the edits stay, the recorded steps go.
  await edit(JSON.stringify({ ...recorded, route: 'REDACTED', notes: 'Pack opened twice' }, null, 2));
  await interact(() => checkbox.click());
  expect(JSON.parse(text.value)).toMatchObject({ route: 'REDACTED', notes: 'Pack opened twice', captureEnabled: false, events: [] });
  expect(document.body.textContent).toContain('Event capture is off');
  expect(document.body.textContent).toContain('Your edits were kept');
  expect(diagnostics.diagnosticSnapshot({}).events).toEqual([]);
  await interact(() => button('Copy report').click());
  const copied = writeText.mock.calls[0][0] as string;
  expect(copied).toBe(text.value);
  expect(copied).not.toContain('unhandled-error');
  expect(JSON.parse(copied)).toMatchObject({ route: 'REDACTED', captureEnabled: false });

  // Opting back in keeps the edits too and states the new consent truthfully.
  await interact(() => checkbox.click());
  expect(JSON.parse(text.value)).toMatchObject({ route: 'REDACTED', notes: 'Pack opened twice', captureEnabled: true, events: [] });
  expect(document.body.textContent).not.toContain('Event capture is off');

  // Explicit Refresh details still regenerates the whole report.
  window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE_KEY_NEVER_SHARE' }));
  await interact(() => button('Refresh details').click());
  expect(JSON.parse(text.value)).toMatchObject({ route: 'opening', captureEnabled: true, events: [{ step: 1, event: 'unhandled-error' }] });
  expect(text.value).not.toContain('REDACTED');

  // Clear recorded steps still empties them.
  await interact(() => button('Clear recorded steps').click());
  expect(JSON.parse(text.value).events).toEqual([]);
  expect(diagnostics.diagnosticSnapshot({}).events).toEqual([]);
});

it('keeps a redacted events field redacted when capture changes', async () => {
  const { text, checkbox, edit, interact } = await mountReport();
  await interact(() => checkbox.click());
  const { events: _events, ...withoutEvents } = JSON.parse(text.value);
  await edit(JSON.stringify(withoutEvents));
  await interact(() => checkbox.click());
  expect(JSON.parse(text.value)).not.toHaveProperty('events');
  expect(JSON.parse(text.value).captureEnabled).toBe(false);
});

it('blocks copying edited text that is no longer JSON until recorded steps are removed from it', async () => {
  const { text, checkbox, edit, writeText, interact } = await mountReport();
  await interact(() => checkbox.click());
  window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE_KEY_NEVER_SHARE' }));
  await interact(() => button('Refresh details').click());
  await edit(`I tapped open twice\n${text.value.slice(text.value.indexOf('"events"'))}`);
  expect(button('Copy report').disabled).toBe(false);

  await interact(() => checkbox.click());
  expect(text.value).toContain('I tapped open twice');
  expect(text.value).toContain('unhandled-error');
  expect(button('Copy report').disabled).toBe(true);
  expect(document.body.textContent).toContain('still has recorded steps');
  expect(text.getAttribute('aria-describedby')!.split(' ').every((target) => document.getElementById(target))).toBe(true);
  expect(writeText).not.toHaveBeenCalled();

  // Removing the steps by hand unblocks it, and the edit is what gets copied.
  await edit('I tapped open twice');
  expect(button('Copy report').disabled).toBe(false);
  expect(document.body.textContent).not.toContain('still has recorded steps');
  await interact(() => button('Copy report').click());
  expect(writeText).toHaveBeenCalledWith('I tapped open twice');
});

it('replaces a blocked draft only when the player refreshes details', async () => {
  const { text, checkbox, edit, interact } = await mountReport();
  await interact(() => checkbox.click());
  window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE_KEY_NEVER_SHARE' }));
  await edit('notes "event": "unhandled-error"');
  await interact(() => checkbox.click());
  expect(button('Copy report').disabled).toBe(true);
  await interact(() => button('Refresh details').click());
  expect(JSON.parse(text.value)).toMatchObject({ captureEnabled: false, events: [] });
  expect(button('Copy report').disabled).toBe(false);
});

const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

it('puts the privacy notice, the editable draft and Copy report before the optional recording controls', async () => {
  const { text, checkbox, interact } = await mountReport();
  const privacy = [...document.querySelectorAll('p')].find((p) => p.textContent!.includes('Never attach a private save'))!;
  const posting = [...document.querySelectorAll('p')].find((p) => p.textContent!.includes('Posting requires a GitHub account'))!;
  const record = document.querySelector<HTMLDetailsElement>('details.diagnostic-record')!;
  const summary = record.querySelector('summary')!;
  const link = document.querySelector<HTMLAnchorElement>('a')!;

  // Essential privacy copy, the draft and its actions come first and are never inside the disclosure.
  expect(before(privacy, text)).toBe(true);
  expect(before(text, button('Copy report'))).toBe(true);
  expect(before(button('Copy report'), record)).toBe(true);
  for (const node of [privacy, posting, text, button('Copy report'), button('Refresh details'), link]) expect(record.contains(node)).toBe(false);
  // The one live region sits between Copy/Refresh and the recording area, beside what triggers it.
  const statuses = document.querySelectorAll('[role="status"]');
  expect(statuses).toHaveLength(1);
  expect(before(button('Refresh details'), statuses[0])).toBe(true);
  expect(before(statuses[0], record)).toBe(true);
  expect(record.contains(statuses[0])).toBe(false);
  // Posting stays secondary: after the recording area, with its disclosure right before the link.
  expect(before(record, posting)).toBe(true);
  expect(before(posting, link)).toBe(true);

  // The recording controls are collapsed, clearly named, and hold the consent and its explanation.
  expect(record.open).toBe(false);
  expect(summary.textContent).toBe('Record steps to reproduce');
  expect(record.contains(checkbox)).toBe(true);
  expect(record.contains(button('Clear recorded steps'))).toBe(true);
  expect(record.textContent).toContain('Capture is optional and starts off');
  expect(checkbox.checked).toBe(false);
  expect(document.body.textContent).toContain('Event capture is off');

  // Opening it is a normal disclosure, and the summary reports the capture state while it is on.
  await interact(() => summary.click());
  expect(record.open).toBe(true);
  await interact(() => checkbox.click());
  expect(summary.textContent).toBe('Record steps to reproduce (on)');
  expect(JSON.parse(text.value).captureEnabled).toBe(true);
});

it('opens the recording area when capture is already on for this tab', async () => {
  await mountReport(true);
  expect(document.querySelector<HTMLDetailsElement>('details.diagnostic-record')!.open).toBe(true);
  expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  expect(document.querySelector('summary')!.textContent).toBe('Record steps to reproduce (on)');
});
