/**
 * Read-only checks of what production serves once a deploy has published it
 * (docs/HOSTING.md#read-only-checks-after-deployment-or-recovery). The deploy's smoke job runs it
 * after publish and deploy, then runs the browser checks (playwright.production.config.ts).
 *
 * GETs only, each with a time limit and a fresh `?smoke=` query so no cache answers. Nothing is
 * submitted, written or deployed. A failed check is tried again at most SMOKE_TRIES times in all,
 * after a short growing pause, so a slow edge doesn't fail a good release but a broken one still
 * fails within about a minute:
 *
 * - (Cloudflare) deployment-id.json names this run's commit, run and address;
 * - the address serves HTML naming a hashed assets/index-*.js entry, and every script and stylesheet
 *   it names is JavaScript or CSS (not the HTML fallback a missing file gets);
 * - hall-of-fame.json is a JSON list of entries whose proofs decode;
 * - a released set's page names a link-preview picture that decodes at its stated size;
 * - (Cloudflare) the old GitHub address serves exactly the forwarding page this commit draws, both at
 *   its root and for an old link (its 404.html), and its own hall-of-fame.json matches production's.
 *
 *   SITE_URL=https://brainrottcg.pages.dev/ HOST=cloudflare OLD_URL=https://evanlin23.github.io/BrainrotTCG/ \
 *     GITHUB_REPOSITORY=evanlin23/BrainrotTCG GITHUB_SHA=<sha> GITHUB_RUN_ID=<run> npx tsx scripts/production-smoke.ts
 *
 * Prints the release's status as Markdown (for $GITHUB_STEP_SUMMARY), an ::error:: line per failed
 * check, and exits 1 if any failed. On a failure it names the newest deploy run on main that passed,
 * as a candidate to roll back to only after the checks in docs/HOSTING.md#recover-on-the-same-origin.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { decodeProof } from '../src/engine/proof.ts';
import { HASHED_ASSET, metaTags } from './check-site.ts';
import { isMainModule } from './main-module.ts';
import { redirectPage } from './redirect-site.ts';

/** How long one GET may take, body included. */
export const TIMEOUT_MS = 15_000;
/** Tries per check in all; the pauses between them double from FIRST_PAUSE_MS. */
export const SMOKE_TRIES = 3;
export const FIRST_PAUSE_MS = 5_000;
/** At most this many scripts and stylesheets are fetched from the entry page. */
export const MAX_ASSETS = 24;
/** A released set, so its page is permanent (docs/ADDING_A_SET.md). */
export const SET_ID = 'genesis';
/** Fetched for an old link, which GitHub Pages answers with 404.html. */
export const OLD_LINK = 's/no-such-set/';

export interface Got {
  status: number;
  /** The Content-Type header, or '' */
  type: string;
  /** The Location header, for a redirect. */
  location: string | null;
  body: Buffer;
}
export type Get = (url: string) => Promise<Got>;

export interface Target {
  /** The production address, ending in one /. */
  url: string;
  host: 'cloudflare' | 'github';
  /** The old GitHub address that forwards to url, while Cloudflare hosts the game. */
  oldUrl: string | null;
  repository: string;
  sha: string;
  runId: string;
  /** Makes every GET this run sends unique, so no cache answers it. */
  tag: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** What the release serves, for the summary. */
export interface Evidence {
  entry?: string;
  assets?: number;
  ranking?: { entries: number; sha256: string };
}

export interface Report {
  checks: Check[];
  evidence: Evidence;
}

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const short = (sha: unknown) => (typeof sha === 'string' ? sha.slice(0, 12) : String(sha));
const pass = (name: string, detail: string): Check => ({ name, ok: true, detail });
const fail = (name: string, detail: string): Check => ({ name, ok: false, detail });
const looksLikeHtml = (body: Buffer) => /^\s*</.test(body.subarray(0, 256).toString('utf8'));
const isHtml = (got: Got) => /^text\/html\b/i.test(got.type);
const isJs = (got: Got) => /^(?:text|application)\/javascript\b/i.test(got.type);
const isCss = (got: Got) => /^text\/css\b/i.test(got.type);
const isJson = (got: Got) => /^application\/json\b/i.test(got.type);

/** url with this run's ?smoke= query. */
export const tagged = (target: Target, url: string) => `${url}${url.includes('?') ? '&' : '?'}smoke=${encodeURIComponent(target.tag)}`;

/** Why a response isn't a plain 200, or null. A redirect counts: the address must answer itself. */
const notOk = (got: Got) =>
  got.status === 200 ? null : got.location ? `HTTP ${got.status} to ${got.location}` : `HTTP ${got.status}`;

/** Fetches once, failing on a thrown error (a timeout, a refused connection) as on a bad answer. */
const fetched = async (get: Get, url: string): Promise<Got | string> => {
  try {
    return await get(url);
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
};

/** Same origin as base and under its path. */
const within = (base: string, href: string) => {
  const url = new URL(href, base);
  return url.origin === new URL(base).origin && url.pathname.startsWith(new URL(base).pathname) ? url.href : null;
};

export const checkMarker = async (target: Target, get: Get): Promise<Check> => {
  const name = 'Release marker (deployment-id.json)';
  const got = await fetched(get, tagged(target, `${target.url}deployment-id.json`));
  if (typeof got === 'string') return fail(name, got);
  const bad = notOk(got);
  if (bad) return fail(name, bad);
  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(got.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return fail(name, 'not JSON');
  }
  if (!marker || typeof marker !== 'object') return fail(name, 'not a JSON object');
  if (marker.sha !== target.sha || marker.run_id !== target.runId) {
    return fail(name, `serves commit ${short(marker.sha)} from run ${String(marker.run_id)}, not this run's commit ${short(target.sha)} `
      + `(run ${target.runId}): a newer deploy, a dashboard rollback or a stale edge`);
  }
  if (marker.url !== target.url || marker.repository !== target.repository) {
    return fail(name, `names ${String(marker.repository)} at ${String(marker.url)}, not ${target.repository} at ${target.url}`);
  }
  return pass(name, `commit ${short(target.sha)}, run ${target.runId}`);
};

const ATTRIBUTE = (key: string) => new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
const attribute = (tag: string, key: string) => {
  const match = ATTRIBUTE(key).exec(tag);
  return match ? match[1] ?? match[2] : undefined;
};

/** The scripts and stylesheets a page loads (module preloads included), in page order. */
export const pageAssets = (html: string): { scripts: string[]; styles: string[] } => {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const rel = attribute(tag, 'rel')?.toLowerCase();
    if (/^<script/i.test(tag)) {
      const src = attribute(tag, 'src');
      if (src) scripts.push(src);
    } else if (rel === 'modulepreload') {
      const href = attribute(tag, 'href');
      if (href) scripts.push(href);
    } else if (rel === 'stylesheet') {
      const href = attribute(tag, 'href');
      if (href) styles.push(href);
    }
  }
  return { scripts, styles };
};

const checkAsset = async (target: Target, get: Get, url: string, kind: 'script' | 'stylesheet'): Promise<string | null> => {
  const got = await fetched(get, url);
  const path = url.slice(target.url.length);
  if (typeof got === 'string') return `${path}: ${got}`;
  const bad = notOk(got);
  if (bad) return `${path}: ${bad}`;
  if (!(kind === 'script' ? isJs(got) : isCss(got))) return `${path}: served as ${got.type || 'no type'}, not ${kind === 'script' ? 'JavaScript' : 'CSS'}`;
  if (got.body.length === 0) return `${path}: empty`;
  if (looksLikeHtml(got.body)) return `${path}: is a page, not a ${kind}`;
  return null;
};

export const checkEntry = async (target: Target, get: Get, evidence: Evidence): Promise<Check> => {
  const name = 'App entry, scripts and stylesheets';
  const got = await fetched(get, tagged(target, target.url));
  if (typeof got === 'string') return fail(name, got);
  const bad = notOk(got);
  if (bad) return fail(name, bad);
  if (!isHtml(got)) return fail(name, `the address is served as ${got.type || 'no type'}, not HTML`);
  const html = got.body.toString('utf8');
  const assets = pageAssets(html);
  const local = (href: string) => within(target.url, href);
  const outside = [...assets.scripts, ...assets.styles].filter((href) => !local(href));
  if (outside.length) return fail(name, `loads code from outside ${target.url}: ${outside.slice(0, 3).join(', ')}`);
  const scripts = [...new Set(assets.scripts.map((href) => local(href)!))];
  const styles = [...new Set(assets.styles.map((href) => local(href)!))];
  const entry = scripts.find((url) => /^assets\/(?:[^/]+\/)*index-[^/]+\.js$/.test(url.slice(target.url.length)) && HASHED_ASSET.test(url.slice(target.url.length)));
  if (!entry) return fail(name, 'the page names no hashed assets/index-*.js entry script');
  evidence.entry = entry.slice(target.url.length);
  const all: (readonly [string, 'script' | 'stylesheet'])[] = [...scripts.map((u) => [u, 'script'] as const), ...styles.map((u) => [u, 'stylesheet'] as const)];
  if (all.length > MAX_ASSETS) return fail(name, `the page names ${all.length} scripts and stylesheets, more than the ${MAX_ASSETS} this checks`);
  const problems = (await Promise.all(all.map(([url, kind]) => checkAsset(target, get, url, kind)))).filter((p): p is string => p !== null);
  evidence.assets = all.length;
  if (problems.length) return fail(name, problems.slice(0, 5).join('; ') + (problems.length > 5 ? `; and ${problems.length - 5} more` : ''));
  return pass(name, `${evidence.entry}, ${scripts.length} scripts and ${styles.length} stylesheets`);
};

/** Why a published Hall of Fame list isn't one, or null. */
export const rankingProblem = (body: Buffer): string | null => {
  let list: unknown;
  try {
    list = JSON.parse(body.toString('utf8'));
  } catch {
    return 'not JSON';
  }
  if (!Array.isArray(list)) return 'not a JSON list';
  for (const [index, entry] of list.entries()) {
    const proof = (entry as { proof?: unknown } | null)?.proof;
    if (typeof proof !== 'string') return `entry ${index} has no proof`;
    try {
      decodeProof(proof);
    } catch (error) {
      return `entry ${index}'s proof doesn't decode (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  return null;
};

const getRanking = async (get: Get, url: string): Promise<{ body: Buffer } | string> => {
  const got = await fetched(get, url);
  if (typeof got === 'string') return got;
  const bad = notOk(got);
  if (bad) return bad;
  if (!isJson(got)) return `served as ${got.type || 'no type'}, not JSON`;
  return rankingProblem(got.body) ?? { body: got.body };
};

export const checkRanking = async (target: Target, get: Get, evidence: Evidence): Promise<Check> => {
  const name = 'Hall of Fame list (hall-of-fame.json)';
  const got = await getRanking(get, tagged(target, `${target.url}hall-of-fame.json`));
  if (typeof got === 'string') return fail(name, got);
  const entries = (JSON.parse(got.body.toString('utf8')) as unknown[]).length;
  evidence.ranking = { entries, sha256: sha256(got.body) };
  return pass(name, `${entries} entries`);
};

/** Why body isn't a JPEG that decodes at width x height, or null. */
export const pictureProblem = async (body: Buffer, width: number, height: number): Promise<string | null> => {
  try {
    const { info } = await sharp(body).raw().toBuffer({ resolveWithObject: true });
    const { format } = await sharp(body).metadata();
    if (format !== 'jpeg') return `is ${format ?? 'an unknown format'}, not a JPEG`;
    if (info.width !== width || info.height !== height) return `is ${info.width}x${info.height}, not ${width}x${height}`;
    return null;
  } catch (error) {
    return `doesn't decode (${error instanceof Error ? error.message : String(error)})`;
  }
};

export const checkSetPage = async (target: Target, get: Get): Promise<Check> => {
  const name = `Set page and its link-preview picture (s/${SET_ID}/)`;
  const got = await fetched(get, tagged(target, `${target.url}s/${SET_ID}/`));
  if (typeof got === 'string') return fail(name, got);
  const bad = notOk(got);
  if (bad) return fail(name, bad);
  if (!isHtml(got)) return fail(name, `served as ${got.type || 'no type'}, not HTML`);
  const tags = metaTags(got.body.toString('utf8'));
  const image = tags.get('og:image');
  const width = Number(tags.get('og:image:width'));
  const height = Number(tags.get('og:image:height'));
  const url = image ? within(target.url, image) : null;
  if (!url || !(width > 0) || !(height > 0)) return fail(name, `names no picture under ${target.url} with its size (og:image ${image ?? 'missing'})`);
  const picture = await fetched(get, tagged(target, url));
  const path = url.slice(target.url.length);
  if (typeof picture === 'string') return fail(name, `${path}: ${picture}`);
  const badPicture = notOk(picture);
  if (badPicture) return fail(name, `${path}: ${badPicture}`);
  if (!/^image\/jpeg\b/i.test(picture.type)) return fail(name, `${path}: served as ${picture.type || 'no type'}, not a JPEG`);
  const problem = await pictureProblem(picture.body, width, height);
  return problem ? fail(name, `${path} ${problem}`) : pass(name, `${path} decodes at ${width}x${height}`);
};

export const checkOldAddress = async (target: Target, get: Get, evidence: Evidence): Promise<Check> => {
  const name = 'Old address forwards here';
  const old = target.oldUrl!;
  const page = redirectPage(target.url, new URL(old).pathname);
  const problems: string[] = [];
  for (const [path, status] of [['', 200], [OLD_LINK, 404]] as const) {
    const got = await fetched(get, tagged(target, `${old}${path}`));
    const where = `${old}${path}`;
    if (typeof got === 'string') problems.push(`${where}: ${got}`);
    else if (got.status !== status) problems.push(`${where}: HTTP ${got.status}${got.location ? ` to ${got.location}` : ''}, not ${status}`);
    else if (!isHtml(got)) problems.push(`${where}: served as ${got.type || 'no type'}, not HTML`);
    else if (got.body.toString('utf8') !== page) problems.push(`${where}: isn't the forwarding page this commit draws for ${target.url}`);
  }
  const ranking = await getRanking(get, tagged(target, `${old}hall-of-fame.json`));
  if (typeof ranking === 'string') problems.push(`${old}hall-of-fame.json: ${ranking}`);
  else if (evidence.ranking && sha256(ranking.body) !== evidence.ranking.sha256) problems.push(`${old}hall-of-fame.json differs from production's`);
  return problems.length ? fail(name, problems.join('; ')) : pass(name, `${old} and its old links forward to ${target.url}`);
};

const defaultPause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** check, tried again after a pause while it fails, at most tries times in all. */
export const retried = async (check: () => Promise<Check>, tries = SMOKE_TRIES, pause = defaultPause): Promise<Check> => {
  let result = await check();
  for (let attempt = 1; attempt < tries && !result.ok; attempt++) {
    await pause(FIRST_PAUSE_MS * 2 ** (attempt - 1));
    result = await check();
  }
  return result;
};

export const smoke = async (target: Target, get: Get, options: { tries?: number; pause?: (ms: number) => Promise<void> } = {}): Promise<Report> => {
  const evidence: Evidence = {};
  const run = (check: () => Promise<Check>) => retried(check, options.tries, options.pause);
  const first = await Promise.all([
    ...(target.host === 'cloudflare' ? [run(() => checkMarker(target, get))] : []),
    run(() => checkEntry(target, get, evidence)),
    run(() => checkRanking(target, get, evidence)),
    run(() => checkSetPage(target, get)),
  ]);
  // The old address's list is compared with production's, so it goes once that is read.
  const old = target.host === 'cloudflare' && target.oldUrl ? [await run(() => checkOldAddress(target, get, evidence))] : [];
  return { checks: [...first, ...old], evidence };
};

/** The newest deploy run on main that passed (its smoke job included), or why it couldn't be found. */
export type PreviousRelease = () => Promise<{ sha: string; url: string } | string>;

export const summary = (target: Target, report: Report, previous: { sha: string; url: string } | string | null): string => {
  const healthy = report.checks.every((c) => c.ok);
  const { evidence } = report;
  const lines = [
    `### Production smoke check: ${healthy ? 'healthy' : 'FAILING'}`, '',
    '| | |', '|---|---|',
    `| Address | ${target.url} (${target.host === 'cloudflare' ? 'Cloudflare Pages' : 'GitHub Pages'}) |`,
    `| Commit | \`${target.sha}\` |`,
    `| Run | ${target.runId} |`,
    `| Entry script | ${evidence.entry ? `\`${evidence.entry}\`` : 'not found'} |`,
    `| hall-of-fame.json | ${evidence.ranking ? `${evidence.ranking.entries} entries, sha256 \`${evidence.ranking.sha256}\`` : 'not read'} |`,
    '', '| Check | Result |', '|---|---|',
    ...report.checks.map((c) => `| ${c.name} | ${c.ok ? 'pass' : 'FAIL'}: ${c.detail.replace(/\|/g, '\\|')} |`), '',
  ];
  if (healthy) {
    lines.push('This release is the known-good target for the next one to roll back to.');
  } else {
    const rollback = typeof previous === 'object' && previous
      ? `The newest deploy run on main that passed these checks: [${short(previous.sha)}](${previous.url}).`
      : `No deploy run on main that passed could be found${previous ? ` (${previous})` : ''}.`;
    lines.push(`${rollback} Don't roll back blindly: a rollback target must still read this release's saves, proofs and sets `
      + '(docs/HOSTING.md#recover-on-the-same-origin); otherwise fix forward on main.');
  }
  return `${lines.join('\n')}\n`;
};

/** A GET that never follows redirects and gives up after TIMEOUT_MS, body included. */
export const httpGet: Get = async (url) => {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'cache-control': 'no-cache', 'user-agent': 'brainrottcg-production-smoke' },
  });
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    location: response.headers.get('location'),
    body: Buffer.from(await response.arrayBuffer()),
  };
};

const exec = promisify(execFile);

export const previousRelease: PreviousRelease = async () => {
  try {
    const { stdout } = await exec('gh', ['run', 'list', '--workflow', 'deploy.yml', '--branch', 'main', '--status', 'success',
      '--limit', '1', '--json', 'headSha,url'], { timeout: TIMEOUT_MS });
    const [latest] = JSON.parse(stdout) as { headSha: string; url: string }[];
    return latest ? { sha: latest.headSha, url: latest.url } : 'none listed';
  } catch (error) {
    return `gh run list failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
  }
};

/** The target from the deploy's environment, or why it can't be read. */
export const targetFromEnv = (env: NodeJS.ProcessEnv): Target | string => {
  const url = env.SITE_URL ?? '';
  const host = env.HOST;
  const ADDRESS = /^https:\/\/[^/?#\s]+\/(?:[^?#\s]+\/)?$/;
  if (!ADDRESS.test(url)) return `SITE_URL ${JSON.stringify(url)} must be an https:// address ending in /`;
  if (host !== 'cloudflare' && host !== 'github') return `HOST must be cloudflare or github, not ${JSON.stringify(host)}`;
  const oldUrl = host === 'cloudflare' ? env.OLD_URL ?? '' : null;
  if (oldUrl !== null && !ADDRESS.test(oldUrl)) return `OLD_URL ${JSON.stringify(oldUrl)} must be an https:// address ending in /`;
  const { GITHUB_REPOSITORY: repository = '', GITHUB_SHA: sha = '', GITHUB_RUN_ID: runId = '', GITHUB_RUN_ATTEMPT: attempt = '1' } = env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(sha) || !/^[1-9]\d*$/.test(runId)) {
    return 'GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_RUN_ID must name this run';
  }
  return { url, host, oldUrl, repository, sha, runId, tag: `${runId}-${attempt}` };
};

export const main = async (env: NodeJS.ProcessEnv, get: Get = httpGet, previous: PreviousRelease = previousRelease,
  options: { tries?: number; pause?: (ms: number) => Promise<void> } = {}): Promise<{ code: number; out: string; errors: string[] }> => {
  const target = targetFromEnv(env);
  if (typeof target === 'string') return { code: 2, out: '', errors: [`::error::${target}`] };
  const report = await smoke(target, get, options);
  const failed = report.checks.filter((c) => !c.ok);
  const out = summary(target, report, failed.length ? await previous() : null);
  return { code: failed.length ? 1 : 0, out, errors: failed.map((c) => `::error title=${c.name}::${target.url}: ${c.detail}`) };
};

if (isMainModule(import.meta.url)) {
  const { code, out, errors } = await main(process.env);
  process.stdout.write(out);
  for (const line of errors) console.error(line);
  process.exitCode = code;
}
