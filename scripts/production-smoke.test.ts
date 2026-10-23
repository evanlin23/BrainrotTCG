import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import vectors from '../spec/vectors.json';
import { redirectPage } from './redirect-site.ts';
import {
  OLD_LINK, POLLS, POLL_MS, SET_ID, httpGet, main, mainStatus, pageAssets, pickPrevious, pickTip, rankingProblem, smoke, status,
  targetFromEnv, type Get, type Got, type MainTip, type Target,
} from './production-smoke.ts';

// No network: every GET goes to a fake site, a map from address (without the ?smoke= query) to answer.

const URL_ = 'https://brainrottcg.pages.dev/';
const OLD = 'https://evanlin23.github.io/BrainrotTCG/';
const SHA = 'a'.repeat(40);
const ENV = {
  SITE_URL: URL_, HOST: 'cloudflare', OLD_URL: OLD,
  GITHUB_REPOSITORY: 'evanlin23/BrainrotTCG', GITHUB_SHA: SHA, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2',
};
const TARGET: Target = { url: URL_, host: 'cloudflare', oldUrl: OLD, repository: 'evanlin23/BrainrotTCG', sha: SHA, runId: '42', tag: '42-2' };

const got = (type: string, body: string | Buffer, status = 200, location: string | null = null): Got =>
  ({ status, type, location, body: Buffer.isBuffer(body) ? body : Buffer.from(body) });
const html = (body: string, status = 200) => got('text/html; charset=utf-8', body, status);

const ENTRY = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-AbCd1234.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-Xy12Ab34.js">
<link rel="stylesheet" crossorigin href="/assets/index-Zz99Yy88.css">
<link rel="icon" href="/favicon.svg">
</head><body><div id="root"></div></body></html>`;
const RANKING = JSON.stringify([{ proof: vectors.valid[0].proof, name: 'x', issue: 1 }]);
const SET_PAGE = `<!doctype html><meta property="og:image" content="${URL_}s/${SET_ID}/preview.jpg">
<meta property="og:image:width" content="8"><meta property="og:image:height" content="4">`;

let jpeg: Buffer;
beforeAll(async () => {
  jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#ffd23f' } }).jpeg().toBuffer();
});

/** The healthy production this commit should serve, with changes. */
const site = (changes: Record<string, Got | Error> = {}): { get: Get; asked: string[] } => {
  const pages: Record<string, Got | Error> = {
    [`${URL_}deployment-id.json`]: got('application/json', JSON.stringify({ repository: 'evanlin23/BrainrotTCG', run_id: '42', sha: SHA, url: URL_ })),
    [URL_]: html(ENTRY),
    [`${URL_}assets/index-AbCd1234.js`]: got('application/javascript', 'import"./vendor-Xy12Ab34.js";'),
    [`${URL_}assets/vendor-Xy12Ab34.js`]: got('text/javascript; charset=utf-8', 'export const a=1;'),
    [`${URL_}assets/index-Zz99Yy88.css`]: got('text/css; charset=utf-8', 'body{margin:0}'),
    [`${URL_}hall-of-fame.json`]: got('application/json', RANKING),
    [`${URL_}s/${SET_ID}/`]: html(SET_PAGE),
    [`${URL_}s/${SET_ID}/preview.jpg`]: got('image/jpeg', jpeg),
    [OLD]: html(redirectPage(URL_, '/BrainrotTCG/')),
    [`${OLD}${OLD_LINK}`]: html(redirectPage(URL_, '/BrainrotTCG/'), 404),
    [`${OLD}hall-of-fame.json`]: got('application/json; charset=utf-8', RANKING),
    [`${OLD}s/${SET_ID}/`]: html(SET_PAGE),
    ...changes,
  };
  const asked: string[] = [];
  const get: Get = async (url) => {
    asked.push(url);
    const answer = pages[url.replace(/[?&]smoke=[^&]*$/, '')] ?? html('<!doctype html>the app', 404);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { get, asked };
};

const noPause = async () => {};
const previous = vi.fn(async () => ({ sha: 'b'.repeat(40), url: 'https://github.com/evanlin23/BrainrotTCG/actions/runs/41' }));
const run = (changes: Record<string, Got | Error> = {}, env: Record<string, string> = ENV) =>
  main(env, site(changes).get, { pause: noPause });
const marker = (run: string, sha = SHA) =>
  got('application/json', JSON.stringify({ repository: 'evanlin23/BrainrotTCG', run_id: run, sha, url: URL_ }));
const failed = async (changes: Record<string, Got | Error>) => {
  const report = await smoke(TARGET, site(changes).get, { pause: noPause });
  return report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
};

afterEach(() => {
  vi.unstubAllGlobals();
  previous.mockClear();
});

describe('a healthy production', () => {
  it('passes every check, with GETs only to its own addresses, each tagged with this run', async () => {
    const { get, asked } = site();
    const report = await smoke(TARGET, get, { pause: noPause });
    expect(report.checks.map((c) => [c.name, c.ok])).toEqual([
      ['Release marker (deployment-id.json)', true],
      ['App entry, scripts and stylesheets', true],
      ['Hall of Fame list (hall-of-fame.json)', true],
      [`Set page and its link-preview picture (s/${SET_ID}/)`, true],
      ['Old address forwards here', true],
    ]);
    expect(report.evidence).toEqual({
      entry: 'assets/index-AbCd1234.js', assets: 3, ranking: { entries: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      preview: { image: `${URL_}s/${SET_ID}/preview.jpg`, width: '8', height: '4' },
    });
    expect(asked).toContain(`${OLD}s/${SET_ID}/?smoke=42-2`);
    expect(asked.every((url) => url.startsWith(URL_) || url.startsWith(OLD))).toBe(true);
    expect(asked.filter((url) => !url.includes('/assets/')).every((url) => url.endsWith('smoke=42-2'))).toBe(true);
  });

  it('exits 0 saying the HTTP checks passed, without yet calling the release known-good', async () => {
    const { code, out, errors } = await run();
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(out).toContain('### Production HTTP checks: passed');
    expect(out).not.toContain('known-good');
    expect(out).toContain('`assets/index-AbCd1234.js`');
  });

  it('on GitHub Pages checks the game at its base path, with no marker or old address', async () => {
    const base = 'https://evanlin23.github.io/BrainrotTCG/';
    const pages: Record<string, Got> = {
      [base]: html(ENTRY.replaceAll('"/assets/', '"/BrainrotTCG/assets/')),
      [`${base}assets/index-AbCd1234.js`]: got('application/javascript', 'x'),
      [`${base}assets/vendor-Xy12Ab34.js`]: got('application/javascript', 'x'),
      [`${base}assets/index-Zz99Yy88.css`]: got('text/css', 'x'),
      [`${base}hall-of-fame.json`]: got('application/json', '[]'),
      [`${base}s/${SET_ID}/`]: html(SET_PAGE.replace(URL_, base)),
      [`${base}s/${SET_ID}/preview.jpg`]: got('image/jpeg', jpeg),
    };
    const get: Get = async (url) => pages[url.replace(/\?smoke=.*$/, '')] ?? html('', 404);
    const { code, out } = await main({ ...ENV, SITE_URL: base, HOST: 'github', OLD_URL: '' }, get, { pause: noPause });
    expect(code).toBe(0);
    expect(out).toContain('| Address | https://evanlin23.github.io/BrainrotTCG/ (GitHub Pages) |');
    expect(out).not.toContain('Release marker');
    expect(out).not.toContain('Old address');
  });
});

describe('a broken production fails loudly', () => {
  it.each([
    ['a newer deploy', { [`${URL_}deployment-id.json`]: marker('43', 'b'.repeat(40)) },
      "Release marker (deployment-id.json): serves commit bbbbbbbbbbbb from run 43, not this run's commit aaaaaaaaaaaa (run 42): a newer deploy"],
    ['this run with another commit', { [`${URL_}deployment-id.json`]: marker('42', 'b'.repeat(40)) }, 'this run with another commit'],
    ['a marker that never catches up', { [`${URL_}deployment-id.json`]: marker('41', 'b'.repeat(40)) },
      `from run 41, not this run's commit aaaaaaaaaaaa (run 42): an older run: a stale edge or a dashboard rollback (still, after ${POLLS} tries`],
    ['a marker for another address', { [`${URL_}deployment-id.json`]: got('application/json', JSON.stringify({ repository: 'evanlin23/BrainrotTCG', run_id: '42', sha: SHA, url: OLD })) },
      `names evanlin23/BrainrotTCG at ${OLD}, not evanlin23/BrainrotTCG at ${URL_}`],
    ['no marker', { [`${URL_}deployment-id.json`]: html('<!doctype html>the app', 404) }, 'Release marker (deployment-id.json): HTTP 404'],
    ['a marker that is the app page', { [`${URL_}deployment-id.json`]: html('<!doctype html>the app') }, 'Release marker (deployment-id.json): not JSON'],
    ['a redirected address', { [URL_]: got('text/html', '', 301, 'https://elsewhere.example/') }, 'App entry, scripts and stylesheets: HTTP 301 to https://elsewhere.example/'],
    ['an address that is not HTML', { [URL_]: got('text/plain', ENTRY) }, 'served as text/plain, not HTML'],
    ['no hashed entry', { [URL_]: html(ENTRY.replace('index-AbCd1234.js', 'main.js')) }, 'names no hashed assets/index-*.js entry script'],
    ['code from another origin', { [URL_]: html(ENTRY.replace('/assets/vendor-Xy12Ab34.js', 'https://cdn.example/x.js')) }, 'loads code from outside'],
    ['a missing stylesheet', { [`${URL_}assets/index-Zz99Yy88.css`]: html('<!doctype html>the app', 404) }, 'assets/index-Zz99Yy88.css: HTTP 404'],
    ['the app page served as a script', { [`${URL_}assets/vendor-Xy12Ab34.js`]: html('<!doctype html>the app') },
      'assets/vendor-Xy12Ab34.js: served as text/html; charset=utf-8, not JavaScript'],
    ['the app page labelled JavaScript', { [`${URL_}assets/vendor-Xy12Ab34.js`]: got('application/javascript', '<!doctype html>the app') },
      'assets/vendor-Xy12Ab34.js: is a page, not a script'],
    ['a stylesheet with the wrong type', { [`${URL_}assets/index-Zz99Yy88.css`]: got('text/plain', 'body{}') }, 'served as text/plain, not CSS'],
    ['an empty entry script', { [`${URL_}assets/index-AbCd1234.js`]: got('application/javascript', '') }, 'assets/index-AbCd1234.js: empty'],
    ['malformed ranking JSON', { [`${URL_}hall-of-fame.json`]: got('application/json', '[{"proof":') }, 'Hall of Fame list (hall-of-fame.json): not JSON'],
    ['a ranking that is the app page', { [`${URL_}hall-of-fame.json`]: html('<!doctype html>the app') }, 'served as text/html; charset=utf-8, not JSON'],
    ['a ranking proof that does not decode', { [`${URL_}hall-of-fame.json`]: got('application/json', '[{"proof":"v9.nope"}]') }, "entry 0's proof doesn't decode"],
    ['a set page with no picture', { [`${URL_}s/${SET_ID}/`]: html('<!doctype html>') }, 'names no picture under'],
    ['a picture that does not decode', { [`${URL_}s/${SET_ID}/preview.jpg`]: got('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])) },
      `s/${SET_ID}/preview.jpg doesn't decode`],
    ['a picture of the wrong size', { [`${URL_}s/${SET_ID}/`]: html(SET_PAGE.replace('content="8"', 'content="16"')) }, 'is 8x4, not 16x4'],
    ['an old address forwarding elsewhere', { [OLD]: html(redirectPage('https://other.pages.dev/', '/BrainrotTCG/')) },
      `${OLD}: isn't the forwarding page this commit draws for ${URL_}`],
    ['old links answered by the app', { [`${OLD}${OLD_LINK}`]: html(redirectPage(URL_, '/BrainrotTCG/')) }, `${OLD}${OLD_LINK}: HTTP 200, not 404`],
    ['an old Hall of Fame list out of step', { [`${OLD}hall-of-fame.json`]: got('application/json', '[]') }, `${OLD}hall-of-fame.json differs from production's`],
    ['old set pages without a link preview', { [`${OLD}s/${SET_ID}/`]: html('<!doctype html>') },
      `${OLD}s/${SET_ID}/: its link preview is missing at ?x?, not production's ${URL_}s/${SET_ID}/preview.jpg at 8x4`],
    ['old set pages with another link preview', { [`${OLD}s/${SET_ID}/`]: html(SET_PAGE.replace('content="8"', 'content="16"')) },
      `${OLD}s/${SET_ID}/: its link preview is ${URL_}s/${SET_ID}/preview.jpg at 16x4`],
    ['no old set pages', { [`${OLD}s/${SET_ID}/`]: html(redirectPage(URL_, '/BrainrotTCG/'), 404) }, `${OLD}s/${SET_ID}/: HTTP 404`],
    ['an unreachable address', { [URL_]: new TypeError('fetch failed') }, 'App entry, scripts and stylesheets: TypeError: fetch failed'],
    ['a timeout', { [`${URL_}hall-of-fame.json`]: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) },
      'TimeoutError: The operation was aborted due to timeout'],
  ])('%s', async (_, changes, expected) => {
    const problems = await failed(changes);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(expected);
  });

  it('exits 1 with an error per failed check, leaving the rollback target to the status step', async () => {
    const { code, out, errors } = await run({
      [`${URL_}assets/vendor-Xy12Ab34.js`]: html('<!doctype html>the app'),
      [`${URL_}hall-of-fame.json`]: got('application/json', 'nope'),
    });
    expect(code).toBe(1);
    expect(errors).toEqual([
      `::error title=App entry, scripts and stylesheets::${URL_}: assets/vendor-Xy12Ab34.js: served as text/html; charset=utf-8, not JavaScript`,
      `::error title=Hall of Fame list (hall-of-fame.json)::${URL_}: not JSON`,
    ]);
    expect(out).toContain('### Production HTTP checks: FAILING');
    expect(out).not.toContain('known-good');
  });
});

describe('waiting for this release', () => {
  /** Production as an edge that serves run 41's release until the first pause, then this run's. */
  const stale = (fresh: Record<string, Got>) => {
    let caughtUp = false;
    const before = site({ [`${URL_}deployment-id.json`]: marker('41', 'b'.repeat(40)) });
    const after = site(fresh);
    const asked: string[] = [];
    const get: Get = (url) => { asked.push(url); return (caughtUp ? after : before).get(url); };
    const pauses: number[] = [];
    const pause = async (ms: number) => { pauses.push(ms); caughtUp = true; };
    return { get, asked, pauses, pause };
  };

  it("checks this run's release, not the one the edge served before it caught up", async () => {
    // This run's index names an entry script the edge doesn't serve: the release is broken, and only a
    // check that waits for the marker sees it.
    const edge = stale({ [URL_]: html(ENTRY.replace('index-AbCd1234.js', 'index-NeWw5678.js')) });
    const report = await smoke(TARGET, edge.get, { pause: edge.pause });
    expect(edge.pauses).toEqual([POLL_MS]);
    expect(report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`))
      .toEqual(['App entry, scripts and stylesheets: assets/index-NeWw5678.js: HTTP 404']);
  });

  it('reads nothing else until the marker names this run', async () => {
    const edge = stale({});
    const report = await smoke(TARGET, edge.get, { pause: edge.pause });
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(edge.asked.slice(0, 2).map((url) => url.replace(/\?.*$/, ''))).toEqual([`${URL_}deployment-id.json`, `${URL_}deployment-id.json`]);
  });

  it('gives up after POLLS asks, POLL_MS apart, and reads nothing else', async () => {
    const { get, asked } = site({ [`${URL_}deployment-id.json`]: marker('41', 'b'.repeat(40)) });
    const pauses: number[] = [];
    const report = await smoke(TARGET, get, { pause: async (ms) => { pauses.push(ms); } });
    expect(report.checks.map((c) => c.ok)).toEqual([false]);
    expect(asked).toHaveLength(POLLS);
    expect(pauses).toEqual(Array(POLLS - 1).fill(POLL_MS));
  });

  it.each([
    ['a newer run', marker('43', 'b'.repeat(40))],
    ['this run with another commit', marker('42', 'b'.repeat(40))],
    ['no marker', html('<!doctype html>the app', 404)],
  ])('fails at once on %s', async (_, answer) => {
    const { get, asked } = site({ [`${URL_}deployment-id.json`]: answer });
    const pause = vi.fn(async () => {});
    const report = await smoke(TARGET, get, { pause });
    expect(report.checks.map((c) => c.ok)).toEqual([false]);
    expect(pause).not.toHaveBeenCalled();
    expect(asked).toHaveLength(1);
  });

  it.each([
    ['an unreachable address', new TypeError('fetch failed')],
    ['a server error', got('text/html', 'busy', 503)],
  ])('asks again after %s', async (_, answer) => {
    let first = true;
    const { get } = site();
    const flaky: Get = async (url) => {
      if (first && url.startsWith(`${URL_}deployment-id.json`)) {
        first = false;
        if (answer instanceof Error) throw answer;
        return answer;
      }
      return get(url);
    };
    const pause = vi.fn(async () => {});
    expect((await smoke(TARGET, flaky, { pause })).checks.every((c) => c.ok)).toBe(true);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("reads this release's content once, with no retries", async () => {
    const { get, asked } = site({ [`${URL_}hall-of-fame.json`]: got('application/json', 'nope') });
    const pause = vi.fn(async () => {});
    await smoke(TARGET, get, { pause });
    expect(asked.filter((url) => url.startsWith(`${URL_}hall-of-fame.json`))).toHaveLength(1);
    expect(asked.some((url) => url.startsWith(OLD))).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it('asks the old address once, so a fault that a second ask would hide still fails', async () => {
    const asked: string[] = [];
    const { get } = site();
    const first = site({ [OLD]: html('<!doctype html>busy', 503) });
    const pause = vi.fn(async () => {});
    const report = await smoke(TARGET, (url) => {
      asked.push(url);
      return url.startsWith(OLD) && asked.filter((u) => u === url).length === 1 ? first.get(url) : get(url);
    }, { pause });
    expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['Old address forwards here']);
    expect(report.checks.at(-1)?.detail).toContain(`${OLD}: HTTP 503`);
    expect(pause).not.toHaveBeenCalled();
    expect(asked.filter((url) => url.startsWith(OLD))).toHaveLength(4);
  });
});

describe('release status', () => {
  const statusOf = (http: string, browser: string, tip: Awaited<ReturnType<MainTip>> = SHA, get: Get = site().get) =>
    mainStatus({ ...ENV, HTTP_OUTCOME: http, BROWSER_OUTCOME: browser }, previous, async () => tip, get);

  it('is known-good only once the HTTP and browser checks both passed', async () => {
    const { code, out } = await statusOf('success', 'success');
    expect(code).toBe(0);
    expect(out).toContain('### Release status: known-good');
    expect(out).toContain('known-good target for the next one to roll back to');
    expect(previous).not.toHaveBeenCalled();
  });

  it('names an earlier release to go back to when the browser checks fail', async () => {
    const { code, out } = await statusOf('success', 'failure');
    expect(code).toBe(0);
    expect(out).toContain('### Release status: FAILING');
    expect(out).toContain('| HTTP checks | success |');
    expect(out).toContain('| Browser checks | failure |');
    expect(out).not.toContain('known-good');
    expect(out).toContain('[bbbbbbbbbbbb](https://github.com/evanlin23/BrainrotTCG/actions/runs/41)');
    expect(out).toContain("Don't roll back blindly");
    expect(previous).toHaveBeenCalledWith(SHA);
  });

  it('is FAILING when the HTTP checks failed and the browser checks never ran', async () => {
    const { out } = await statusOf('failure', 'skipped');
    expect(out).toContain('### Release status: FAILING');
    expect(out).toContain('| Browser checks | skipped |');
    expect(out).toContain('[bbbbbbbbbbbb]');
  });

  it('says to fix forward when no earlier release can be found', async () => {
    const out = status(TARGET, 'failure', '', 'gh run list failed: no token');
    expect(out).toContain('| Browser checks | not run |');
    expect(out).toContain('No earlier release on main could be found (gh run list failed: no token): fix forward on main.');
  });

  it.each([['cancelled', 'cancelled'], ['success', 'cancelled'], ['cancelled', 'skipped'], ['success', '']])(
    'gives no verdict and no rollback target when a check was cancelled (HTTP %s, browser %s)', async (http, browser) => {
      const tip = vi.fn(async () => SHA);
      const { code, out } = await mainStatus({ ...ENV, HTTP_OUTCOME: http, BROWSER_OUTCOME: browser }, previous, tip);
      expect(code).toBe(0);
      expect(out).toContain('### Release status: cancelled, no verdict');
      expect(out).not.toMatch(/FAILING|known-good target|roll back/);
      expect(previous).not.toHaveBeenCalled();
      expect(tip).not.toHaveBeenCalled();
    });

  it.each([['success', 'skipped'], ['skipped', 'skipped'], ['skipped', 'success']])(
    'gives no verdict and no rollback target when a check was skipped and none failed (HTTP %s, browser %s)', async (http, browser) => {
      const tip = vi.fn(async () => SHA);
      const get = vi.fn(site().get);
      const { code, out } = await mainStatus({ ...ENV, HTTP_OUTCOME: http, BROWSER_OUTCOME: browser }, previous, tip, get);
      expect(code).toBe(0);
      expect(out).toContain('### Release status: unfinished, no verdict');
      expect(out).toContain(`The checks didn't finish (HTTP ${http}, browser ${browser})`);
      expect(out).not.toMatch(/FAILING|known-good target|roll back/);
      expect(previous).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });

  it('gives no verdict on a failure while production serves a newer run, even of this same commit', async () => {
    for (const sha of [SHA, 'b'.repeat(40)]) {
      const { get, asked } = site({ [`${URL_}deployment-id.json`]: marker('43', sha) });
      const { out } = await statusOf('failure', 'skipped', SHA, get);
      expect(out).toContain('### Release status: superseded, no verdict');
      expect(out).toContain('Production serves run 43, a newer deploy');
      expect(out).not.toMatch(/FAILING|known-good target|roll back/);
      expect(asked.map((url) => url.replace(/\?.*$/, ''))).toEqual([`${URL_}deployment-id.json`]);
    }
    expect(previous).not.toHaveBeenCalled();
  });

  it.each([
    ['names this run', marker('42')],
    ['names an older run', marker('41', 'b'.repeat(40))],
    ['names a newer run of another address', got('application/json', JSON.stringify({ repository: 'evanlin23/BrainrotTCG', run_id: '43', sha: SHA, url: OLD }))],
    ['is not JSON', html('<!doctype html>the app')],
    ['does not answer', new Error('timeout')],
  ])('stays FAILING, with a rollback target, when the marker %s', async (_case, answer) => {
    const { out } = await statusOf('success', 'failure', SHA, site({ [`${URL_}deployment-id.json`]: answer }).get);
    expect(out).toContain('### Release status: FAILING');
    expect(out).toContain('[bbbbbbbbbbbb]');
  });

  it('reads no marker for a release that passed', async () => {
    const get = vi.fn(site().get);
    expect((await statusOf('success', 'success', SHA, get)).out).toContain('### Release status: known-good');
    expect(get).not.toHaveBeenCalled();
  });

  it("never calls an older commit known-good, or offers a rollback for it, once main has moved past it", async () => {
    for (const [http, browser] of [['success', 'success'], ['failure', 'skipped']]) {
      const { out } = await statusOf(http, browser, 'c'.repeat(40));
      expect(out).toContain('### Release status: superseded, no verdict');
      expect(out).toContain("main is now at `cccccccccccc`, not this run's commit");
      expect(out).not.toMatch(/FAILING|known-good target|roll back/);
    }
    expect(previous).not.toHaveBeenCalled();
  });

  it('gives no verdict when the tip of main cannot be read', async () => {
    const { out } = await statusOf('success', 'success', { problem: 'git ls-remote failed: timeout' });
    expect(out).toContain('### Release status: no verdict');
    expect(out).toContain('The tip of main could not be read (git ls-remote failed: timeout)');
    expect(out).not.toContain('known-good target');
  });

  it("reads main's commit from git ls-remote, and nothing else", () => {
    expect(pickTip(`${SHA}\trefs/heads/main\n`)).toBe(SHA);
    expect(pickTip(`${'b'.repeat(40)}\trefs/heads/mainline\n${SHA}\trefs/heads/main\n`)).toBe(SHA);
    expect(pickTip('')).toBeNull();
    expect(pickTip('nope\trefs/heads/main\n')).toBeNull();
  });

  it("never offers this run's own commit, or nothing, as the rollback target", () => {
    const run = (sha: string, n: number) => ({ headSha: sha, url: `https://github.com/evanlin23/BrainrotTCG/actions/runs/${n}` });
    expect(pickPrevious([run(SHA, 40), run('b'.repeat(40), 39)], SHA)).toEqual({ sha: 'b'.repeat(40), url: run('b', 39).url });
    expect(pickPrevious([run(SHA, 40)], SHA)).toBeNull();
    expect(pickPrevious([], SHA)).toBeNull();
  });

  it('exits 2 when the environment is wrong', async () => {
    expect((await mainStatus({ ...ENV, GITHUB_SHA: '' }, previous)).code).toBe(2);
  });
});

describe('parsing', () => {
  it('finds the scripts, module preloads and stylesheets a page loads, whatever the attribute order and quotes', () => {
    expect(pageAssets(`<script src='/a.js' type="module"></script><script>inline()</script>
      <link href="/b.js" rel="modulepreload"><link rel='stylesheet' href='/c.css'><link rel="preload" href="/d.woff2">`))
      .toEqual({ scripts: ['/a.js', '/b.js'], styles: ['/c.css'] });
  });

  it('takes a Hall of Fame list only as a JSON list of entries whose proofs decode', () => {
    expect(rankingProblem(Buffer.from(RANKING))).toBeNull();
    expect(rankingProblem(Buffer.from('[]'))).toBeNull();
    expect(rankingProblem(Buffer.from('{}'))).toBe('not a JSON list');
    expect(rankingProblem(Buffer.from('[null]'))).toBe('entry 0 has no proof');
    expect(rankingProblem(Buffer.from('[{"proof":1}]'))).toBe('entry 0 has no proof');
  });

  it('reads the deploy environment, and refuses one that does not name a run and an address', () => {
    expect(targetFromEnv(ENV)).toEqual(TARGET);
    expect(targetFromEnv({ ...ENV, HOST: 'github', OLD_URL: undefined })).toEqual({ ...TARGET, host: 'github', oldUrl: null });
    expect(targetFromEnv({ ...ENV, SITE_URL: 'https://brainrottcg.pages.dev' })).toMatch(/^SITE_URL/);
    expect(targetFromEnv({ ...ENV, SITE_URL: 'http://brainrottcg.pages.dev/' })).toMatch(/^SITE_URL/);
    expect(targetFromEnv({ ...ENV, HOST: '' })).toMatch(/^HOST/);
    expect(targetFromEnv({ ...ENV, OLD_URL: '' })).toMatch(/^OLD_URL/);
    expect(targetFromEnv({ ...ENV, GITHUB_SHA: 'main' })).toMatch(/^GITHUB_REPOSITORY/);
  });

  it('exits 2 without checking anything when the environment is wrong', async () => {
    const { get, asked } = site();
    expect(await main({ ...ENV, GITHUB_RUN_ID: '' }, get)).toEqual({ code: 2, out: '', errors: [expect.stringMatching(/^::error::GITHUB_REPOSITORY/)] });
    expect(asked).toEqual([]);
  });

  it('GETs without following redirects, with a time limit', async () => {
    const fetch = vi.fn(async () => new Response('body', { status: 302, headers: { 'content-type': 'text/html', location: '/x' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await httpGet(`${URL_}?smoke=1`)).toEqual({ status: 302, type: 'text/html', location: '/x', body: Buffer.from('body') });
    expect(fetch).toHaveBeenCalledWith(`${URL_}?smoke=1`, expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }));
  });
});
