import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const folder = fileURLToPath(new URL('../workers/hall-of-fame-cron/', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

interface CronWorker {
  scheduled(event: unknown, env: { GITHUB_TOKEN: string }): Promise<void>;
  fetch(request: Request, env: { GITHUB_TOKEN: string }): Promise<Response>;
}
// A plain JS file with no types, so it is loaded by URL rather than imported (the test projects don't compile JS).
const { default: worker } = (await import(pathToFileURL(`${folder}index.js`).href)) as { default: CronWorker };

const ENV = { GITHUB_TOKEN: 'ghp_test_token' };
const EVENT = { cron: '*/15 * * * *', scheduledTime: 0 };
const DISPATCH = 'https://api.github.com/repos/evanlin23/BrainrotTCG/actions/workflows/hall-of-fame-inbox.yml/dispatches';

const fetchMock = vi.fn<typeof fetch>();
const answer = (status: number, body = '') => fetchMock.mockResolvedValue(new Response(status === 204 ? null : body, { status }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('scheduled', () => {
  it('asks GitHub to run the Hall of Fame inbox workflow on main, once', async () => {
    answer(204);

    await expect(worker.scheduled(EVENT, ENV)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(DISPATCH);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer ghp_test_token',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'brainrot-hall-of-fame-cron',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    expect(JSON.parse(init?.body as string)).toStrictEqual({ ref: 'main' });
  });

  it('dispatches a workflow file that exists and accepts workflow_dispatch', () => {
    const file = DISPATCH.match(/\/actions\/workflows\/([^/]+)\/dispatches$/)![1];
    const path = `${repoRoot}.github/workflows/${file}`;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it('is what the Cloudflare cron trigger runs, every 15 minutes', () => {
    const wrangler = readFileSync(`${folder}wrangler.toml`, 'utf8');
    expect(wrangler).toMatch(/^main = "index\.js"$/m);
    expect(wrangler).toMatch(/^crons = \["\*\/15 \* \* \* \*"\]$/m);
  });

  describe('anything but 204 fails the run', () => {
    it.each([200, 201, 202, 301, 401, 403, 404, 422, 500, 503])('throws for %i with the status in the message', async (status) => {
      answer(status, 'body text');
      await expect(worker.scheduled(EVENT, ENV)).rejects.toThrow(`GitHub answered ${status}: body text`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('includes the first 300 characters of a long answer and no more', async () => {
      const body = `${'a'.repeat(300)}${'b'.repeat(700)}`;
      answer(502, body);
      const error = await worker.scheduled(EVENT, ENV).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`GitHub answered 502: ${'a'.repeat(300)}`);
    });

    it('keeps an answer of exactly 300 characters whole', async () => {
      answer(400, 'c'.repeat(300));
      await expect(worker.scheduled(EVENT, ENV)).rejects.toThrow(new Error(`GitHub answered 400: ${'c'.repeat(300)}`));
    });

    it('handles an empty answer', async () => {
      answer(500, '');
      await expect(worker.scheduled(EVENT, ENV)).rejects.toThrow(new Error('GitHub answered 500: '));
    });
  });

  it('lets a network failure fail the run instead of swallowing it', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(worker.scheduled(EVENT, ENV)).rejects.toThrow('fetch failed');
  });
});

describe('fetch', () => {
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('answers %s with 404 and starts nothing', async (method) => {
    const request = new Request('https://hall-of-fame-cron.example.workers.dev/?run=1', { method, ...(method === 'GET' ? {} : { body: '{"ref":"main"}' }) });

    const response = await worker.fetch(request, ENV);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 404 whatever the path, even one that looks like the dispatch', async () => {
    for (const path of ['/', '/dispatch', '/scheduled', '/repos/evanlin23/BrainrotTCG/actions/workflows/hall-of-fame-inbox.yml/dispatches']) {
      const response = await worker.fetch(new Request(`https://hall-of-fame-cron.example.workers.dev${path}`), ENV);
      expect(response.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
