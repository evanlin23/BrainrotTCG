import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeProof, generateKeypair, pullId, signProof } from '../engine';

vi.mock('./pulls', () => ({ checkPull: vi.fn() }));
vi.mock('./share', () => ({ wasSubmitted: vi.fn() }));

describe('loadHallOfFame', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('retries after HTTP failure (e.g. 500 status code)', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: 'Internal Server Error' }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'entry-1', proof: 'proof1' }],
        } as unknown as Response;
      }),
    );

    const firstResult = await loadHallOfFame();
    expect(firstResult).toBeNull();

    const secondResult = await loadHallOfFame();
    expect(secondResult).toEqual([{ id: 'entry-1', proof: 'proof1' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries after rejected fetch (e.g. network failure)', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new TypeError('Failed to fetch');
        }
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'entry-1', proof: 'proof1' }],
        } as unknown as Response;
      }),
    );

    const firstResult = await loadHallOfFame();
    expect(firstResult).toBeNull();

    const secondResult = await loadHallOfFame();
    expect(secondResult).toEqual([{ id: 'entry-1', proof: 'proof1' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries after invalid JSON response', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token < in JSON at position 0');
            },
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'entry-1', proof: 'proof1' }],
        } as unknown as Response;
      }),
    );

    const firstResult = await loadHallOfFame();
    expect(firstResult).toBeNull();

    const secondResult = await loadHallOfFame();
    expect(secondResult).toEqual([{ id: 'entry-1', proof: 'proof1' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries after non-array JSON response', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ message: 'Maintenance mode' }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'entry-1', proof: 'proof1' }],
        } as unknown as Response;
      }),
    );

    const firstResult = await loadHallOfFame();
    expect(firstResult).toBeNull();

    const secondResult = await loadHallOfFame();
    expect(secondResult).toEqual([{ id: 'entry-1', proof: 'proof1' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent callers to share one request', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    let resolveFetch: (res: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });

    const mockFetch = vi.fn(() => fetchPromise);
    vi.stubGlobal('fetch', mockFetch);

    const caller1 = loadHallOfFame();
    const caller2 = loadHallOfFame();
    const caller3 = loadHallOfFame();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    resolveFetch!({
      ok: true,
      status: 200,
      json: async () => [{ id: 'shared-1', proof: 'proof-shared' }],
    } as unknown as Response);

    const [res1, res2, res3] = await Promise.all([caller1, caller2, caller3]);
    expect(res1).toEqual([{ id: 'shared-1', proof: 'proof-shared' }]);
    expect(res2).toEqual(res1);
    expect(res3).toEqual(res1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('caches successful results and empty arrays across subsequent calls', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 'entry-cached', proof: 'proof-cached' }],
    } as unknown as Response));
    vi.stubGlobal('fetch', mockFetch);

    const first = await loadHallOfFame();
    expect(first).toEqual([{ id: 'entry-cached', proof: 'proof-cached' }]);

    const second = await loadHallOfFame();
    expect(second).toEqual([{ id: 'entry-cached', proof: 'proof-cached' }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('caches empty array results across subsequent calls', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    } as unknown as Response));
    vi.stubGlobal('fetch', mockFetch);

    const first = await loadHallOfFame();
    expect(first).toEqual([]);

    const second = await loadHallOfFame();
    expect(second).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves existing legacy-ID behavior intact', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    const { secretKey, publicKey } = generateKeypair();
    const proofObj = signProof({ setId: 'test-set', setVersion: 1, publicKey, nonce: 1, name: 'Alice' }, secretKey);
    const validProofStr = encodeProof(proofObj);
    const expectedPullId = pullId(proofObj);

    const mockData = [
      { id: 'explicit-id-1', proof: 'any-proof-1' },
      { proof: validProofStr },
      { proof: 'invalid-proof-text' },
    ];

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => mockData,
    } as unknown as Response)));

    const result = await loadHallOfFame();
    expect(result).toEqual([
      { id: 'explicit-id-1', proof: 'any-proof-1' },
      { proof: validProofStr, id: expectedPullId },
      { proof: 'invalid-proof-text', id: 'invalid-proof-text' },
    ]);
  });
});
