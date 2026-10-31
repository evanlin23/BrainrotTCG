// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { retryMayHelp, sheetLoader } from './sheetEntry';

const Screen = () => null;

it('shares one request between warming up and opening, and remembers the screen', async () => {
  const importer = vi.fn(async () => ({ default: Screen }));
  const load = sheetLoader(importer);
  expect(load.loaded).toBeUndefined();
  const [first, second] = [load(), load()];
  expect(first).toBe(second);
  await first;
  expect(load.loaded).toBe(Screen);
  await load();
  expect(importer).toHaveBeenCalledOnce();
});

it('forgets a failed request, so opening or Retry asks again', async () => {
  const importer = vi.fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
    .mockResolvedValueOnce({ default: Screen });
  const load = sheetLoader(importer);
  await expect(load()).rejects.toThrow('Failed to fetch');
  expect(load.loaded).toBeUndefined();
  await expect(load()).resolves.toEqual({ default: Screen });
  expect(importer).toHaveBeenCalledTimes(2);
  expect(load.loaded).toBe(Screen);
});

it("leaves other screens' stylesheets alone: one still loading neither fails this screen nor is removed", async () => {
  // A warmed-up screen's stylesheet has no sheet until it arrives (#664 review: prefetch while another page loads).
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/assets/Other-123.css';
  document.head.append(link);
  const load = sheetLoader(async () => ({ default: Screen }));
  await expect(load()).resolves.toEqual({ default: Screen });
  expect(load.loaded).toBe(Screen);
  expect(link.isConnected).toBe(true);
  link.remove();
});

it('keeps Retry after the first failure, and after any failure while offline, but not after a failed Retry online', () => {
  expect(retryMayHelp(0)).toBe(true);
  expect(retryMayHelp(1)).toBe(false);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  expect(retryMayHelp(1)).toBe(true);
  expect(retryMayHelp(3)).toBe(true);
});
