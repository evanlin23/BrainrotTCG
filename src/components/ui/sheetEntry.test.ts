import { expect, it, vi } from 'vitest';
import { sheetLoader } from './sheetEntry';

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
