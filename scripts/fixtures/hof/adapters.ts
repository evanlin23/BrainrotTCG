/**
 * Test-side network: replaces the global `fetch` and `WebSocket` with the in-memory fakes in
 * ./fakes.ts (the fakes themselves carry no vitest import, so scripts/hof-capacity.ts can use them).
 */
import { vi } from 'vitest';
import { FakeGitHub, FakeRelays } from './fakes.ts';

export * from './fakes.ts';

/**
 * Replaces the global `fetch` and `WebSocket` for one test. Requests go to the GitHub and relay fakes
 * once they're set; anything else throws and lands in `blocked`, which the test's afterEach checks is
 * empty (the script catches some network errors, so a throw alone wouldn't fail the test).
 */
export const offlineNetwork = () => {
  const blocked: string[] = [];
  const net = { github: null as FakeGitHub | null, relays: null as FakeRelays | null, blocked };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const res = net.github?.handle(url, init);
      if (res) return res;
      blocked.push(`fetch ${init.method ?? 'GET'} ${url}`);
      throw new Error(`no network in tests: ${init.method ?? 'GET'} ${url}`);
    }),
  );
  // `new WebSocket(url)` returns the fake socket (a constructor may return an object).
  vi.stubGlobal('WebSocket', function FakeWebSocket(url: string) {
    const socket = net.relays?.connect(String(url));
    if (socket) return socket;
    blocked.push(`WebSocket ${url}`);
    throw new Error(`no network in tests: WebSocket ${url}`);
  });
  return net;
};
