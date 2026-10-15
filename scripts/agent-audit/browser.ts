import type { BrowserContext, Page } from '@playwright/test';
import { clean } from './contracts';

// Every context is disposable. No evaluation, arbitrary navigation, file, clipboard or form tools
// are exposed to the agent; this coordinator alone owns the browser.
export async function isolate(context: BrowserContext, baseURL: string) {
  const base = new URL(baseURL);
  const blocked: string[] = [];
  const noteBlocked = (reason: string) => { if (blocked.length < 40) blocked.push(reason); };
  await context.routeWebSocket('**/*', (socket) => { noteBlocked('websocket'); socket.close(); });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || request.method() !== 'GET') {
      noteBlocked('network request');
      return route.fulfill({ status: 204 });
    }
    const response = await route.fetch({ maxRedirects: 0 });
    const headers = { ...response.headers() };
    // Worker fetches inherit this policy as well; external writes remain forbidden even if
    // a worker is outside Playwright's HTTP routing coverage.
    headers['content-security-policy'] = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; form-action 'none'; frame-src 'none'; base-uri 'self'";
    await route.fulfill({ response, headers });
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem('brainrot-player-v1')) localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Disposable local audit', nextNonce: 0, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ musicVolume: 0, effectsVolume: 0 }));
    const denied = () => Promise.reject(new Error('Unavailable in a read-only audit'));
    Object.defineProperty(navigator, 'clipboard', { configurable: false, value: { writeText: denied, write: denied, readText: denied, read: denied } });
    Object.defineProperty(navigator, 'share', { configurable: false, value: denied });
    window.open = () => null;
  });
  return blocked;
}
export async function browserCommand(page: Page, body: unknown, steps: string[]) {
  if (!body || typeof body !== 'object') throw Error('Invalid browser command');
  const { name, arguments: args } = body as { name: unknown; arguments?: Record<string, unknown> };
  if (steps.length >= 40) throw Error('Browser step budget exhausted');
  if (name === 'click') {
    if (!args || !['button', 'link'].includes(String(args.role)) || typeof args.name !== 'string' || args.name.length > 150) throw Error('Invalid click');
    // Even local exports/copy/share are outside the audit; reports must never contain saves.
    if (/export|import|download|copy|share|submit|publish|sign.?in|log.?in/i.test(args.name)) throw Error('This action is read-only in this audit');
    steps.push(`click: ${clean(args.name)}`);
    await page.getByRole(args.role as 'button' | 'link', { name: args.name, exact: true }).click({ timeout: 5000 });
  } else if (name === 'press') {
    if (!args || !['Tab', 'Shift+Tab', 'Enter', 'Escape', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(String(args.key))) throw Error('Invalid key');
    // Keyboard activation could reach a forbidden export/share control; keep the same guard.
    const active = page.locator(':focus');
    const focused = await active.count() ? await active.getAttribute('aria-label') ?? await active.textContent() : '';
    if (['Enter', 'Space'].includes(String(args.key)) && /export|import|download|copy|share|submit|publish|sign.?in|log.?in/i.test(focused ?? '')) throw Error('This action is read-only in this audit');
    steps.push(`press: ${args.key}`);
    await page.keyboard.press(String(args.key));
  } else if (name === 'wait') {
    steps.push('wait: 1 second');
    await page.waitForTimeout(1000);
  } else if (name === 'snapshot') steps.push('snapshot: visible accessibility tree');
  else throw Error('Unsupported browser command');
  return (await page.locator('body').ariaSnapshot()).slice(0, 18000);
}
