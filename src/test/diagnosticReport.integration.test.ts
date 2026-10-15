// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => {
  const diagnostics = await import('../game/diagnostics');
  diagnostics.setBrowserDiagnosticCapture(false);
  await app?.dispose();
  app = undefined;
});
const button = (text: string) => {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === text);
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
  localStorage.setItem('brainrot-player-v1', 'PRIVATE_KEY_NEVER_SHARE');
  history.replaceState(null, '', '#/pull/PRIVATE_PROOF_NEVER_SHARE');
  await app.interact(() => button('Refresh details').click());
  expect(text.value).not.toContain('PRIVATE_');
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await app.interact(() => checkbox.click());
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
  expect(new URL(link.href).search).toBe('');
  expect(link.rel).toContain('noopener');
  await app.interact(() => button('Clear recorded steps').click());
  expect(diagnostics.diagnosticSnapshot({}).events).toEqual([]);
  await app.interact(() => checkbox.click());
  expect(diagnostics.isDiagnosticCaptureEnabled()).toBe(false);
  diagnostics.setBrowserDiagnosticCapture(false);
});
