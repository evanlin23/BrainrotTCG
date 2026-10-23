import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import vectors from '../spec/vectors.json';
import { redirectPage } from './redirect-site.ts';
import {
  FIRST_PAUSE_MS, OLD_LINK, SET_ID, SMOKE_TRIES, httpGet, main, pageAssets, rankingProblem, retried, smoke, summary, targetFromEnv,
  type Get, type Got, type Target,
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
  main(env, site(changes).get, previous, { pause: noPause });
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
    expect(report.evidence).toEqual({ entry: 'assets/index-AbCd1234.js', assets: 3, ranking: { entries: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(asked.every((url) => url.startsWith(URL_) || url.startsWith(OLD))).toBe(true);
    expect(asked.filter((url) => !url.includes('/assets/')).every((url) => url.endsWith('smoke=42-2'))).toBe(true);
  });

  it('exits 0 with a healthy summary, without looking up an older release', async () => {
    const { code, out, errors } = await run();
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(out).toContain('### Production smoke check: healthy');
    expect(out).toContain('known-good target');
    expect(out).toContain('`assets/index-AbCd1234.js`');
    expect(previous).not.toHaveBeenCalled();
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
    const { code, out } = await main({ ...ENV, SITE_URL: base, HOST: 'github', OLD_URL: '' }, get, previous, { pause: noPause });
    expect(code).toBe(0);
    expect(out).toContain('| Address | https://evanlin23.github.io/BrainrotTCG/ (GitHub Pages) |');
    expect(out).not.toContain('Release marker');
    expect(out).not.toContain('Old address');
  });
});

describe('a broken production fails loudly', () => {
  it.each([
    ['another commit', { [`${URL_}deployment-id.json`]: got('application/json', JSON.stringify({ repository: 'evanlin23/BrainrotTCG', run_id: '41', sha: 'b'.repeat(40), url: URL_ })) },
      "Release marker (deployment-id.json): serves commit bbbbbbbbbbbb from run 41, not this run's commit aaaaaaaaaaaa (run 42)"],
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
    ['an unreachable address', { [URL_]: new TypeError('fetch failed') }, 'App entry, scripts and stylesheets: TypeError: fetch failed'],
    ['a timeout', { [`${URL_}hall-of-fame.json`]: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) },
      'TimeoutError: The operation was aborted due to timeout'],
  ])('%s', async (_, changes, expected) => {
    const problems = await failed(changes);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(expected);
  });

  it('exits 1 with an error per failed check, and names the newest release that passed', async () => {
    const { code, out, errors } = await run({
      [`${URL_}assets/vendor-Xy12Ab34.js`]: html('<!doctype html>the app'),
      [`${URL_}hall-of-fame.json`]: got('application/json', 'nope'),
    });
    expect(code).toBe(1);
    expect(errors).toEqual([
      `::error title=App entry, scripts and stylesheets::${URL_}: assets/vendor-Xy12Ab34.js: served as text/html; charset=utf-8, not JavaScript`,
      `::error title=Hall of Fame list (hall-of-fame.json)::${URL_}: not JSON`,
    ]);
    expect(out).toContain('### Production smoke check: FAILING');
    expect(out).toContain('[bbbbbbbbbbbb](https://github.com/evanlin23/BrainrotTCG/actions/runs/41)');
    expect(out).toContain("Don't roll back blindly");
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it('says when no release that passed can be found', () => {
    const report = { checks: [{ name: 'x', ok: false, detail: 'a | b' }], evidence: {} };
    const out = summary(TARGET, report, 'gh run list failed: no token');
    expect(out).toContain('No deploy run on main that passed could be found (gh run list failed: no token).');
    expect(out).toContain('| x | FAIL: a \\| b |');
    expect(out).toContain('| Entry script | not found |');
  });
});

describe('retries', () => {
  it('a check that fails and then passes passes, after one pause', async () => {
    const pauses: number[] = [];
    const check = vi.fn().mockResolvedValueOnce({ name: 'x', ok: false, detail: 'slow edge' }).mockResolvedValue({ name: 'x', ok: true, detail: 'fine' });
    expect(await retried(check, SMOKE_TRIES, async (ms) => { pauses.push(ms); })).toEqual({ name: 'x', ok: true, detail: 'fine' });
    expect(pauses).toEqual([FIRST_PAUSE_MS]);
  });

  it('a check that keeps failing is tried SMOKE_TRIES times with growing pauses, then fails', async () => {
    const pauses: number[] = [];
    const check = vi.fn().mockResolvedValue({ name: 'x', ok: false, detail: 'down' });
    expect((await retried(check, SMOKE_TRIES, async (ms) => { pauses.push(ms); })).ok).toBe(false);
    expect(check).toHaveBeenCalledTimes(SMOKE_TRIES);
    expect(pauses).toEqual([FIRST_PAUSE_MS, 2 * FIRST_PAUSE_MS]);
  });

  it('a broken production is asked a bounded number of times', async () => {
    const { get, asked } = site({ [`${URL_}hall-of-fame.json`]: got('application/json', 'nope') });
    await smoke(TARGET, get, { pause: noPause });
    expect(asked.filter((url) => url.startsWith(`${URL_}hall-of-fame.json`))).toHaveLength(SMOKE_TRIES);
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
    expect(await main({ ...ENV, GITHUB_RUN_ID: '' }, get, previous)).toEqual({ code: 2, out: '', errors: [expect.stringMatching(/^::error::GITHUB_REPOSITORY/)] });
    expect(asked).toEqual([]);
  });

  it('GETs without following redirects, with a time limit', async () => {
    const fetch = vi.fn(async () => new Response('body', { status: 302, headers: { 'content-type': 'text/html', location: '/x' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await httpGet(`${URL_}?smoke=1`)).toEqual({ status: 302, type: 'text/html', location: '/x', body: Buffer.from('body') });
    expect(fetch).toHaveBeenCalledWith(`${URL_}?smoke=1`, expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }));
  });
});
