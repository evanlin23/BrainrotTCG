import { expect, test } from '@playwright/test';
import { browserCommand, isolate } from '../../scripts/agent-audit/browser';

test('local agent boundary blocks writes and exposes only visible read-only actions', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  const steps: string[] = [];
  try {
    const blocked = await isolate(context, baseURL!);
    const page = await context.newPage();
    await page.goto(baseURL!);
    expect(await browserCommand(page, { name: 'snapshot' }, steps)).toContain('Brainrot');
    await browserCommand(page, { name: 'press', arguments: { key: 'Tab' } }, steps);
    expect(steps).toContain('press: Tab');
    // Fulfilled at the browser boundary, never sent to a real provider.
    const status = await page.evaluate(async () => (await fetch(location.href, { method: 'POST', body: 'disposable' })).status);
    expect(status).toBe(204);
    expect(blocked).toContain('network request');
    await expect(browserCommand(page, { name: 'evaluate', arguments: { script: 'localStorage' } }, steps)).rejects.toThrow('Unsupported');
    await expect(browserCommand(page, { name: 'click', arguments: { role: 'button', name: 'Export save' } }, steps)).rejects.toThrow('read-only');
    await expect(browserCommand(page, { name: 'click', arguments: { role: 'button', name: 'Anything' } }, Array(40).fill('snapshot'))).rejects.toThrow('budget');
    await expect(page.evaluate(() => navigator.clipboard.writeText('disposable'))).rejects.toThrow('read-only audit');
    await expect(page.evaluate(() => navigator.share({ title: 'disposable' }))).rejects.toThrow('read-only audit');
    const csp = await page.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy'));
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'none'");
    const untouched = await browser.newContext();
    try {
      const other = await untouched.newPage();
      await other.goto(baseURL!);
      expect(await other.evaluate(() => localStorage.getItem('brainrot-player-v1')) ?? '').not.toContain('Disposable local audit');
    } finally { await untouched.close(); }
  } finally { await context.close(); }
});
