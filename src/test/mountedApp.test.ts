// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, describe, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

describe('mountedApp until', () => {
  it('succeeds immediately without advancing time when condition already holds on cold-run', async () => {
    app = await mountedApp({});
    await app.mount();
    let runs = 0;
    await app.until('already true', () => {
      runs += 1;
      expect(document.querySelector('.app')).not.toBeNull();
    });
    expect(runs).toBe(1);
  });

  it('times out when condition never holds within budget', async () => {
    app = await mountedApp({});
    await app.mount();
    await expect(app.until('never true', () => {
      expect(1).toBe(2);
    }, 50)).rejects.toThrow('never true: AssertionError: expected 1 to be 2');
  });
});
