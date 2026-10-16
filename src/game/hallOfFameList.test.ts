import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeProof, generateKeypair, pullId, signProof } from '../engine';

vi.mock('./pulls', () => ({ checkPull: vi.fn() }));
vi.mock('./share', () => ({ wasSubmitted: vi.fn() }));
const fetchEvents = vi.hoisted(() => vi.fn());
vi.mock('./nostrInbox', () => ({ fetchEvents, proofFromEvent: vi.fn(), HOF_KIND: 30_078, HOF_TAG: 'hof' }));

const mockResponse = (data: unknown, ok = true, status = 200) =>
  ({
    ok,
    status,
    json: async () => data,
  }) as unknown as Response;

const mockSuccessResponse = (entries: unknown = [{ id: 'entry-1', proof: 'proof1' }]) => mockResponse(entries);

describe('loadHallOfFame', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries after HTTP failure (e.g. 500 status code)', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return mockResponse({ error: 'Internal Server Error' }, false, 500);
        }
        return mockSuccessResponse();
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
        return mockSuccessResponse();
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
        return mockSuccessResponse();
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
          return mockResponse({ message: 'Maintenance mode' });
        }
        return mockSuccessResponse();
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

    resolveFetch!(mockSuccessResponse([{ id: 'shared-1', proof: 'proof-shared' }]));

    const [res1, res2, res3] = await Promise.all([caller1, caller2, caller3]);
    expect(res1).toEqual([{ id: 'shared-1', proof: 'proof-shared' }]);
    expect(res2).toEqual(res1);
    expect(res3).toEqual(res1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up on a load that never settles, so a later call fetches again', async () => {
    vi.useFakeTimers();
    try {
      const { loadHallOfFame } = await import('./hallOfFameList');
      // A request that hangs until its signal aborts, as a stalled connection would.
      const mockFetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      vi.stubGlobal('fetch', mockFetch);

      const first = loadHallOfFame();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(mockFetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(first).resolves.toBeNull();

      mockFetch.mockImplementationOnce(async () => mockSuccessResponse([{ id: 'late-1', proof: 'proof-late' }]));
      await expect(loadHallOfFame()).resolves.toEqual([{ id: 'late-1', proof: 'proof-late' }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches successful results and empty arrays across subsequent calls', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    const mockFetch = vi.fn(async () => mockSuccessResponse([{ id: 'entry-cached', proof: 'proof-cached' }]));
    vi.stubGlobal('fetch', mockFetch);

    const first = await loadHallOfFame();
    expect(first).toEqual([{ id: 'entry-cached', proof: 'proof-cached' }]);

    const second = await loadHallOfFame();
    expect(second).toEqual([{ id: 'entry-cached', proof: 'proof-cached' }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('caches empty array results across subsequent calls', async () => {
    const { loadHallOfFame } = await import('./hallOfFameList');
    const mockFetch = vi.fn(async () => mockSuccessResponse([]));
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

    vi.stubGlobal('fetch', vi.fn(async () => mockSuccessResponse(mockData)));

    const result = await loadHallOfFame();
    expect(result).toEqual([
      { id: 'explicit-id-1', proof: 'any-proof-1' },
      { proof: validProofStr, id: expectedPullId },
      { proof: 'invalid-proof-text', id: 'invalid-proof-text' },
    ]);
  });
});

describe('loadPending', () => {
  beforeEach(() => {
    fetchEvents.mockReset();
    fetchEvents.mockResolvedValue({ events: [], perRelay: [] });
  });

  it('hands its abort signal to the relay read', async () => {
    const { loadPending } = await import('./hallOfFameList');
    const controller = new AbortController();
    await loadPending([], vi.fn(), controller.signal);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(fetchEvents.mock.calls[0][5]).toBe(controller.signal);
  });

  it('reads no relays once already aborted', async () => {
    const { loadPending } = await import('./hallOfFameList');
    const controller = new AbortController();
    controller.abort();
    const onEntry = vi.fn();
    await loadPending([], onEntry, controller.signal);
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(onEntry).not.toHaveBeenCalled();
  });

  describe('a pull that only makes today’s top', () => {
    afterEach(() => vi.useRealTimers());

    // 100 pulls above it, and the first of its hand in its set already taken: it can only join
    // through the daily top 50 (UTC).
    const entry = (id: string, score: number, submittedAt: string) =>
      ({ id, setId: 'test-set', hand: 'Full House', multiplier: 150, score, submittedAt }) as unknown as import('./hallOfFameList').HallOfFameEntry;
    const board = (todays: number) => [
      ...Array.from({ length: 100 }, (_, i) => entry(`top-${i}`, 100_000 + i, '2026-10-01T00:00:00.000Z')),
      ...Array.from({ length: todays }, (_, i) => entry(`today-${i}`, 20_000 + i, '2026-10-16T01:00:00.000Z')),
    ];

    const pending = async (published: ReturnType<typeof board>) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
      const { secretKey, publicKey } = generateKeypair();
      const proof = encodeProof(signProof({ setId: 'test-set', setVersion: 1, publicKey, nonce: 1, name: 'Alice' }, secretKey));
      const { proofFromEvent } = await import('./nostrInbox');
      const { checkPull } = await import('./pulls');
      vi.mocked(proofFromEvent).mockReturnValue(proof);
      vi.mocked(checkPull).mockResolvedValue({
        set: { id: 'test-set', name: 'Test Set' },
        score: { score: 10_000, hand: { name: 'Full House', multiplier: 150 } },
        proof: { name: 'Alice' },
        fingerprint: 'fp',
        cards: [],
      } as never);
      fetchEvents.mockResolvedValue({ events: [{ created_at: 1 }], perRelay: [] });
      const { loadPending } = await import('./hallOfFameList');
      const onEntry = vi.fn();
      await loadPending(published, onEntry, new AbortController().signal);
      return onEntry;
    };

    it('shows it while today’s top 50 has room', async () => {
      const onEntry = await pending(board(49));
      expect(onEntry).toHaveBeenCalledTimes(1);
      expect(onEntry.mock.calls[0][0]).toMatchObject({ score: 10_000, pending: true, submittedAt: '2026-10-16T12:00:00.000Z' });
    });

    it('leaves it out once today’s top 50 is full of better pulls', async () => {
      const onEntry = await pending(board(50));
      expect(onEntry).not.toHaveBeenCalled();
    });
  });
});
