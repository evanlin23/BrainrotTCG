import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStaging, isStagingHost } from './staging';

const PAGES = 'brainrottcg.pages.dev';
const g = globalThis as unknown as { window?: unknown };

const at = (url: string) => {
  const { hostname, origin } = new URL(url);
  g.window = { location: { hostname, origin, hash: '' } };
};

afterEach(() => {
  vi.unstubAllEnvs();
  delete g.window;
});

describe('isStagingHost', () => {
  it('is staging only on a subdomain of the project host', () => {
    expect(isStagingHost(`staging.${PAGES}`, PAGES)).toBe(true);
    expect(isStagingHost(`0f3c2a91.${PAGES}`, PAGES)).toBe(true);
    expect(isStagingHost(`STAGING.${PAGES.toUpperCase()}.`, PAGES)).toBe(true);
    // Production, at the project host or a custom domain, and anything else is not.
    expect(isStagingHost(PAGES, PAGES)).toBe(false);
    expect(isStagingHost('brainrottcg.net', PAGES)).toBe(false);
    expect(isStagingHost('evanlin23.github.io', PAGES)).toBe(false);
    expect(isStagingHost(`staging.not${PAGES}`, PAGES)).toBe(false);
    expect(isStagingHost(`staging.${PAGES}.evil.example`, PAGES)).toBe(false);
  });

  it('is never staging when the build names no project host', () => {
    expect(isStagingHost(`staging.${PAGES}`, '')).toBe(false);
    expect(isStagingHost('.', '.')).toBe(false);
  });
});

describe('isStaging', () => {
  it('reads the build-time project host and the page address', () => {
    vi.stubEnv('VITE_STAGING_HOST_SUFFIX', PAGES);
    at(`https://staging.${PAGES}/`);
    expect(isStaging()).toBe(true);
    at(`https://${PAGES}/`);
    expect(isStaging()).toBe(false);
    vi.stubEnv('VITE_STAGING_HOST_SUFFIX', '');
    at(`https://staging.${PAGES}/`);
    expect(isStaging()).toBe(false);
  });

  it('turns off bringing a save from the old address on staging', async () => {
    vi.stubEnv('VITE_STAGING_HOST_SUFFIX', PAGES);
    vi.stubEnv('VITE_OLD_ORIGIN', 'https://evanlin23.github.io');
    vi.stubEnv('VITE_OLD_SITE_URL', 'https://evanlin23.github.io/BrainrotTCG/');
    vi.resetModules(); // move.ts reads the old address when it loads
    const { canBringOldSave } = await import('./move');
    at(`https://${PAGES}/`);
    expect(canBringOldSave()).toBe(true);
    at(`https://staging.${PAGES}/`);
    expect(canBringOldSave()).toBe(false);
  });
});
