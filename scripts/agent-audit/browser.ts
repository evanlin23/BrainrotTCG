import type { IncomingMessage, ServerResponse } from 'node:http';
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
export const stepBudget = 40;
const keys = ['Tab', 'Shift+Tab', 'Enter', 'Escape', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const readOnly = /export|import|download|copy|share|submit|publish|sign.?in|log.?in/i;
/** A refusal this adapter wrote itself, safe to show the agent; other failures stay generic. */
export class BrowserRefusal extends Error {}

export async function browserCommand(page: Page, body: unknown, steps: string[]) {
  if (!body || typeof body !== 'object') throw new BrowserRefusal('Invalid browser command');
  const { name, arguments: args } = body as { name: unknown; arguments?: Record<string, unknown> };
  if (steps.length >= stepBudget) throw new BrowserRefusal('Browser step budget exhausted');
  let step: string;
  let act = async () => {};
  if (name === 'click') {
    if (!args || !['button', 'link'].includes(String(args.role)) || typeof args.name !== 'string' || args.name.length > 150) throw new BrowserRefusal('Invalid click');
    const role = args.role as 'button' | 'link';
    const label = args.name;
    if (!label.trim()) throw new BrowserRefusal('Click needs the exact, non-empty accessible name of one control from snapshot');
    // Even local exports/copy/share are outside the audit; reports must never contain saves.
    if (readOnly.test(label)) throw new BrowserRefusal('This action is read-only in this audit');
    step = `click: ${clean(label)}`;
    act = async () => {
      const target = page.getByRole(role, { name: label, exact: true });
      const matches = await target.count();
      if (!matches) throw new BrowserRefusal(`No visible ${role} has that exact name; take a snapshot and use a listed name`);
      if (matches > 1) throw new BrowserRefusal(`${matches} visible ${role}s share that exact name; nothing was clicked, so move focus with keys and press Enter instead`);
      await target.click({ timeout: 5000 });
    };
  } else if (name === 'press') {
    if (!args || !keys.includes(String(args.key))) throw new BrowserRefusal('Invalid key');
    const key = String(args.key);
    step = `press: ${key}`;
    act = async () => {
      if (key === 'Enter' || key === 'Space') {
        // Keyboard activation could reach a forbidden export/share control; keep the same guard.
        const active = page.locator(':focus');
        const focused = await active.count() ? await active.getAttribute('aria-label') ?? await active.textContent() : '';
        if (readOnly.test(focused ?? '')) throw new BrowserRefusal('This action is read-only in this audit');
      }
      await page.keyboard.press(key);
    };
  } else if (name === 'wait') {
    step = 'wait: 1 second';
    act = () => page.waitForTimeout(1000);
  } else if (name === 'snapshot') step = 'snapshot: visible accessibility tree';
  else throw new BrowserRefusal('Unsupported browser command');
  // Reserve the slot before the first await, so concurrent calls cannot overshoot the budget. A
  // refused or failed action keeps its slot but is relabelled, so it never counts as evidence.
  const slot = steps.push(step) - 1;
  try {
    await act();
    return (await page.locator('body').ariaSnapshot()).slice(0, 18000);
  } catch (error) { steps[slot] = `not completed: ${step}`; throw error; }
}

/** The bridge's HTTP handler: this adapter's own refusals pass through as 400s, other failures stay generic. */
export function bridgeHandler(token: string, run: (command: unknown) => Promise<string>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== `/${token}` || request.method !== 'POST') { response.writeHead(404).end(); return; }
    let body = '';
    try {
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 4096) throw Error('Oversized command');
      }
      response.end(await run(JSON.parse(body)));
    } catch (error) { response.writeHead(400).end(error instanceof BrowserRefusal ? error.message : 'Browser action blocked or unavailable'); }
  };
}
