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

  it('fetches the list again once it is five minutes old, so an open tab picks up a removal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
      const { loadHallOfFame } = await import('./hallOfFameList');
      const mockFetch = vi.fn(async () => mockSuccessResponse([{ id: 'removed-later', proof: 'p' }]));
      vi.stubGlobal('fetch', mockFetch);
      await loadHallOfFame();

      vi.setSystemTime(new Date('2026-10-16T12:04:59.999Z'));
      mockFetch.mockImplementation(async () => mockSuccessResponse([]));
      await expect(loadHallOfFame()).resolves.toEqual([{ id: 'removed-later', proof: 'p' }]);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-10-16T12:05:00Z'));
      await expect(loadHallOfFame()).resolves.toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1]).toEqual([expect.stringMatching(/\/hall-of-fame\.json$/), expect.objectContaining({ cache: 'no-cache' })]);
      // ...and keeps the new one for the next five minutes.
      await loadHallOfFame();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last list that loaded when a refetch fails, and tries again on the next read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
      const { loadHallOfFame } = await import('./hallOfFameList');
      const mockFetch = vi.fn(async () => mockSuccessResponse([{ id: 'kept', proof: 'p' }]));
      vi.stubGlobal('fetch', mockFetch);
      await loadHallOfFame();

      vi.setSystemTime(new Date('2026-10-16T12:05:00Z'));
      mockFetch.mockImplementation(async () => mockResponse(null, false, 503));
      await expect(loadHallOfFame()).resolves.toEqual([{ id: 'kept', proof: 'p' }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      mockFetch.mockImplementation(async () => mockSuccessResponse([]));
      await expect(loadHallOfFame()).resolves.toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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
  // The list of pulls a maintainer rejected (hall-of-fame-withdrawn.json): none, unless a test says.
  const withdrawnFetch = vi.fn();
  beforeEach(() => {
    fetchEvents.mockReset();
    fetchEvents.mockResolvedValue({ events: [], perRelay: [] });
    withdrawnFetch.mockReset();
    withdrawnFetch.mockImplementation(async () => mockResponse([]));
    vi.stubGlobal('fetch', withdrawnFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

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

  describe('whether any relay could be read', () => {
    const run = async (signal = new AbortController().signal) => (await import('./hallOfFameList')).loadPending([], vi.fn(), signal);

    it('is false when every relay failed', async () => {
      fetchEvents.mockResolvedValue({ events: [], perRelay: [{ relay: 'wss://a', count: 0, error: 'connection failed' }, { relay: 'wss://b', count: 0, error: 'timed out' }] });
      expect(await run()).toBe(false);
    });

    it('is true when a relay answered with nothing, so the board really is empty', async () => {
      fetchEvents.mockResolvedValue({ events: [], perRelay: [{ relay: 'wss://a', count: 0, error: 'timed out' }, { relay: 'wss://b', count: 0 }] });
      expect(await run()).toBe(true);
    });

    it('is true when events came back, whatever the per-relay report says', async () => {
      fetchEvents.mockResolvedValue({ events: [{ created_at: 1 }], perRelay: [{ relay: 'wss://a', count: 1, error: 'closed' }] });
      expect(await run()).toBe(true);
    });

    it('is true when aborted, since nobody is waiting on the answer', async () => {
      const controller = new AbortController();
      fetchEvents.mockImplementation(async () => {
        controller.abort();
        return { events: [], perRelay: [{ relay: 'wss://a', count: 0, error: 'aborted' }] };
      });
      expect(await run(controller.signal)).toBe(true);
    });

    it("is still reported when the list of rejected pulls can't be loaded, and a reached feed says pending went unchecked", async () => {
      withdrawnFetch.mockImplementation(async () => mockResponse(null, false, 404));
      fetchEvents.mockResolvedValue({ events: [], perRelay: [{ relay: 'wss://a', count: 0, error: 'connection failed' }] });
      expect(await run()).toBe(false);
      fetchEvents.mockResolvedValue({ events: [], perRelay: [{ relay: 'wss://a', count: 0 }] });
      expect(await run()).toBe('unchecked');
    });
  });

  it('reads the list of rejected pulls fresh, next to the published list, and stops when the page goes', async () => {
    const { loadPending } = await import('./hallOfFameList');
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    withdrawnFetch.mockImplementation((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      controller.abort();
      return Promise.resolve(mockResponse([]));
    });
    await loadPending([], vi.fn(), controller.signal);
    expect(withdrawnFetch).toHaveBeenCalledTimes(1);
    expect(withdrawnFetch.mock.calls[0]).toEqual([expect.stringMatching(/\/hall-of-fame-withdrawn\.json$/), expect.objectContaining({ cache: 'no-cache' })]);
    expect(seen?.aborted).toBe(true);
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

    // The clock reads 2026-10-16T12:00Z: an event from 09:00 that day, and one from two days before.
    const sentToday = Date.parse('2026-10-16T09:00:00Z') / 1000;
    const sentTwoDaysAgo = Date.parse('2026-10-14T09:00:00Z') / 1000;

    const pending = async (published: ReturnType<typeof board>, createdAt = sentToday, name = 'Alice', withdrawn: (id: string) => Promise<Response> = async () => mockResponse([])) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
      const { secretKey, publicKey } = generateKeypair();
      const signed = signProof({ setId: 'test-set', setVersion: 1, publicKey, nonce: 1, name }, secretKey);
      const proof = encodeProof(signed);
      withdrawnFetch.mockImplementation(() => withdrawn(pullId(signed)));
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
      fetchEvents.mockResolvedValue({ events: [{ created_at: createdAt }], perRelay: [] });
      const { loadPending } = await import('./hallOfFameList');
      const onEntry = vi.fn();
      await loadPending(published, onEntry, new AbortController().signal);
      return onEntry;
    };

    it('shows it while today’s top 50 has room', async () => {
      const onEntry = await pending(board(49));
      expect(onEntry).toHaveBeenCalledTimes(1);
      expect(onEntry.mock.calls[0][0]).toMatchObject({ score: 10_000, pending: true, submittedAt: '2026-10-16T12:00:00.000Z', githubUser: 'nostr', submittedVia: 'relay' });
    });

    it("leaves out a pull whose display name isn't allowed, without checking it (the inbox never files it)", async () => {
      const { checkPull } = await import('./pulls');
      const before = vi.mocked(checkPull).mock.calls.length;
      expect(await pending(board(0), sentToday, 'xXfuckXx')).not.toHaveBeenCalled();
      expect(vi.mocked(checkPull).mock.calls.length).toBe(before);
    });

    it('leaves out a pull a maintainer rejected, without checking it', async () => {
      const { checkPull } = await import('./pulls');
      const before = vi.mocked(checkPull).mock.calls.length;
      expect(await pending(board(0), sentToday, 'Alice', async (id) => mockResponse(['another-pull', id]))).not.toHaveBeenCalled();
      expect(vi.mocked(checkPull).mock.calls.length).toBe(before);
      // The same pull, while nobody has rejected it.
      expect(await pending(board(0), sentToday, 'Alice', async () => mockResponse(['another-pull']))).toHaveBeenCalledTimes(1);
    });

    it("shows nothing pending when the list of rejected pulls can't be loaded, so a removed pull never comes back", async () => {
      const { checkPull } = await import('./pulls');
      const before = vi.mocked(checkPull).mock.calls.length;
      for (const withdrawn of [
        async () => mockResponse(null, false, 404),
        async () => Promise.reject(new TypeError('Failed to fetch')),
        async () => ({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('Unexpected token')) }) as unknown as Response,
        async () => mockResponse({ withdrawn: [] }),
        async () => mockResponse(['a-pull', 7]),
      ]) {
        expect(await pending(board(0), sentToday, 'Alice', withdrawn)).not.toHaveBeenCalled();
      }
      expect(vi.mocked(checkPull).mock.calls.length).toBe(before);
    });

    it('gives up on a list of rejected pulls that never loads within the relays\' 5 s, and shows nothing pending', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
      const { secretKey, publicKey } = generateKeypair();
      const proof = encodeProof(signProof({ setId: 'test-set', setVersion: 1, publicKey, nonce: 1, name: 'Alice' }, secretKey));
      const { proofFromEvent } = await import('./nostrInbox');
      vi.mocked(proofFromEvent).mockReturnValue(proof);
      fetchEvents.mockResolvedValue({ events: [{ created_at: sentToday }], perRelay: [] });
      // A request that hangs until its signal aborts, as a stalled connection would.
      withdrawnFetch.mockImplementation((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      const { loadPending } = await import('./hallOfFameList');
      const onEntry = vi.fn();
      let reached: boolean | 'unchecked' | undefined;
      void loadPending(board(0), onEntry, new AbortController().signal).then((r) => (reached = r));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(reached).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(reached).toBe('unchecked');
      expect(onEntry).not.toHaveBeenCalled();
    });

    it('leaves it out once today’s top 50 is full of better pulls', async () => {
      const onEntry = await pending(board(50));
      expect(onEntry).not.toHaveBeenCalled();
    });

    it('leaves it out when it was sent before today (UTC), though today’s top has room', async () => {
      // Its day's daily entries have left the published list, so only the send time keeps it from
      // coming back as one of today's.
      expect(await pending(board(0), sentTwoDaysAgo)).not.toHaveBeenCalled();
      expect(await pending(board(49), Date.parse('2026-10-15T23:59:59Z') / 1000)).not.toHaveBeenCalled();
      expect(await pending(board(49), Date.parse('2026-10-16T00:00:00Z') / 1000)).toHaveBeenCalledTimes(1);
    });

    it('marks only a pull this device sent as its own', async () => {
      const { wasSubmitted } = await import('./share');
      vi.mocked(wasSubmitted).mockReturnValue(true);
      const mine = await pending(board(0));
      expect(mine.mock.calls[0][0]).toMatchObject({ pending: true, mine: true });

      vi.mocked(wasSubmitted).mockReturnValue(false);
      const theirs = await pending(board(0));
      expect(theirs).toHaveBeenCalledTimes(1);
      expect(theirs.mock.calls[0][0]).toMatchObject({ pending: true });
      expect(theirs.mock.calls[0][0]).not.toHaveProperty('mine');
    });

    it('still shows an older one that would join the all-time list', async () => {
      // Room in the top 100: it joins all-time, whenever it was sent.
      const onEntry = await pending(board(0).slice(1), sentTwoDaysAgo);
      expect(onEntry).toHaveBeenCalledTimes(1);
      expect(onEntry.mock.calls[0][0]).toMatchObject({ score: 10_000, pending: true, submittedAt: '2026-10-16T12:00:00.000Z' });
    });
  });
});

describe('provenanceText', () => {
  it('says relay for an entry the relay inbox filed', async () => {
    const { provenanceText } = await import('./hallOfFameList');
    expect(provenanceText({ githubUser: 'nostr', submittedVia: 'relay' })).toBe('via relay');
  });

  it('reads a snapshot from before submittedVia was published by its nostr marker', async () => {
    const { provenanceText } = await import('./hallOfFameList');
    expect(provenanceText({ githubUser: 'nostr' })).toBe('via relay');
    expect(provenanceText({ githubUser: 'alice' })).toBe('via GitHub');
    expect(provenanceText({ githubUser: 'unknown' })).toBeNull();
  });

  it('says GitHub issue for an issue author, without naming the login', async () => {
    const { provenanceText } = await import('./hallOfFameList');
    expect(provenanceText({ githubUser: 'alice', submittedVia: 'github' })).toBe('via GitHub');
    expect(provenanceText({ githubUser: 'a-b-9', submittedVia: 'github' })).toBe('via GitHub');
  });

  it('never takes a GitHub user named nostr for the relay', async () => {
    const { provenanceText } = await import('./hallOfFameList');
    expect(provenanceText({ githubUser: 'nostr', submittedVia: 'github' })).toBe('via GitHub');
  });

  it('says nothing for a missing, unknown or odd value', async () => {
    const { provenanceText } = await import('./hallOfFameList');
    for (const odd of [undefined, null, 7, {}, '', 'unknown', 'not a login', '-alice', 'alice-', 'a--b', 'x'.repeat(40), '<b>hi</b>']) {
      expect(provenanceText({ githubUser: odd })).toBeNull();
      expect(provenanceText({ githubUser: odd, submittedVia: 'github' })).toBeNull();
    }
    expect(provenanceText({})).toBeNull();
    for (const via of [null, 7, '', 'Relay', 'nostr', {}]) expect(provenanceText({ githubUser: 'alice', submittedVia: via })).toBeNull();
  });
});
