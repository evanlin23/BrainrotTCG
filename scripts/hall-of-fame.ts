/**
 * The global Hall of Fame, with GitHub Issues as the database and this script
 * as the verifier. Nothing is trusted: every proof is re-derived from scratch.
 *
 *   npx tsx scripts/hall-of-fame.ts verify-issue   (Actions, on an issue event)
 *     Reads the issue from $GITHUB_EVENT_PATH, verifies its pull link and writes
 *     hof-comment.md plus `verified`, `changed`, `redeploy`, `label` and `rejected` to
 *     $GITHUB_OUTPUT. A verified comment carries a marker with the pull id. `label` is `verified`
 *     for a pull that makes the all-time top pulls, or `daily`
 *     for one that only makes the day's top (see "Labels" below). An edit that keeps a pull
 *     the bot already verified on the issue writes an empty comment file and, if its labels are
 *     incomplete, repairs them (`changed`). `redeploy` is set for a new verification, and for a
 *     repair only when the bot's latest comment is that pull's verified one (the run stopped
 *     before labelling) and the next build would list a pull the published list doesn't have.
 *
 *   npx tsx scripts/hall-of-fame.ts inbox           (Actions, on a schedule)
 *     Reads submissions sent without a GitHub account through public Nostr relays
 *     (src/game/nostrInbox.ts), verifies each pull, and files every one that
 *     qualifies as a bot-authored Hall of Fame issue with the same verified
 *     marker, so `build` treats it like any other entry. Writes `added` to
 *     $GITHUB_OUTPUT. Event ids it has seen are kept in hof-inbox-seen.json
 *     (cached between runs) so junk isn't re-checked every time, and the time
 *     ranges each relay was read through in hof-inbox-read.json (cached too), so
 *     events past the page cap are read by a later run.
 *
 *   npx tsx scripts/hall-of-fame.ts build           (deploy, before vite build)
 *     Lists verified Hall of Fame issues (and `daily` ones from the day before
 *     on), verifies each proof, and writes the
 *     list (the top pulls and the daily top of the build's UTC day and the day
 *     before, at most HALL_OF_FAME_MAX_ENTRIES; src/engine/hallOfFame.ts) to
 *     public/hall-of-fame.json. Results are kept in hof-build-cache.json (cached
 *     between deploys): an issue unchanged since the last deploy isn't checked
 *     again, so a deploy's cost grows with new submissions, not with all of them.
 *     Without a token, or if GitHub is down, it keeps the existing file.
 *
 * The inbox and the issue verifier only add a pull that would join the list, so
 * the number of entries stays about the same however many people play.
 *
 * Labels: a pull that makes the top pulls is labelled `verified`
 * and is listed by every deploy. One that only makes its UTC day's top (up to
 * 50 a day) is labelled `daily`, and deploys only list those updated since the
 * day before, so the issues a deploy reads don't grow with the daily ones. So
 * that such a pull counts on one day's top only, the inbox and verify-issue
 * turn it down while another issue updated in the last 8 days carries it under
 * `daily` (`recentIssuesSince`); one filed again after that can count again.
 * Every issue listing reads all its pages, and fails rather than stop short.
 * An issue labelled `rejected` is never listed: verify-issue adds that label to a pull whose display
 * name isn't allowed (src/engine/nameFilter.ts), and the owner adds it to remove an entry by hand.
 *
 * Ties (and a pull's UTC day) use the time the bot first verified that exact
 * pull on the issue (its marker comment), not the issue's creation date:
 * otherwise anyone could open a placeholder issue early and edit a pull in later.
 *
 * Security: issue bodies are untrusted input. They are only ever parsed here,
 * never interpolated into a shell command, and echoed only through safe().
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSet } from '../src/content/sets/index.ts';
import {
  decodeProof,
  extractProof,
  HALL_OF_FAME_DAILY_TOP,
  HALL_OF_FAME_MIN_SCORE,
  HALL_OF_FAME_TOP,
  hallOfFameFloor,
  hallOfFameJoin,
  hallOfFameList,
  isNameAllowed,
  previousUtcDay,
  publicName,
  pullId,
  qualifiesForHallOfFame,
  utcDay,
  verifyProof,
  type RankableEntry,
  type TicketFn,
  type VerifiedPull,
  type Finish,
} from '../src/engine/index.ts';
import { fetchEvents, HOF_KIND, HOF_RELAYS, HOF_TAG, probeEvent, publishEvent } from '../src/game/nostrInbox.ts';
import { addRanges, buildSkipLine, clipRanges, deferredFrom, everyRelayFailed, newestGap, oldestGap, olderReadLine, parseReadRanges, parseSeenCache, probeLine, processInbox, rangeRead, relayReadLine, seenCacheText, type Ranges } from './hof-inbox.ts';
import { isMainModule } from './main-module.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT = `${ROOT}public/hall-of-fame.json`;
const REPO = process.env.GITHUB_REPOSITORY ?? 'evanlin23/BrainrotTCG';
const BOT = 'github-actions[bot]';
const API = 'https://api.github.com';
const markerFor = (id: string) => `<!-- hof-verified ${id} -->`;

export interface HallOfFameEntry extends RankableEntry {
  proof: string;
  name: string;
  fingerprint: string;
  setId: string;
  setVersion: number;
  setName: string;
  hand: string;
  multiplier: number;
  score: number;
  /** finish and misprint only for cards from sets with modifiers. */
  cards: { cardId: string; isHolo: boolean; finish?: Finish | null; misprint?: boolean }[];
  /** Trusted, from GitHub: who submitted, and when the bot first verified this pull. */
  issue: number;
  githubUser: string;
  submittedAt: string;
}

interface Issue {
  number: number;
  title: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  labels: ({ name?: string } | string)[];
  pull_request?: unknown;
}

const labelNames = (issue: Issue) => issue.labels.map((l) => (typeof l === 'string' ? l : l.name ?? ''));
/** Accepted only for its day's top (see "Labels" above). */
const isDailyOnly = (issue: Issue) => labelNames(issue).includes('daily') && !labelNames(issue).includes('verified');
/** The UTC day now (YYYY-MM-DD), for the daily top. */
const today = () => utcDay(new Date().toISOString());

/** Plain text for markdown: no formatting, mentions, issue references or links. */
const safe = (text: string) =>
  text
    .replace(/[`*_[\]<>|]/g, '')
    .replace(/@/g, '@\u200B')
    .replace(/#/g, '#\u200B')
    .replace(/:\/\//g, ':\u200B//')
    .replace(/[\r\n]+/g, ' ');

const toEntry = (pull: VerifiedPull, proof: string, issue: Issue, verifiedAt: string): HallOfFameEntry => ({
  id: pullId(pull.proof),
  proof,
  name: pull.proof.name,
  fingerprint: pull.fingerprint,
  setId: pull.set.id,
  setVersion: pull.set.version,
  setName: pull.set.name,
  hand: pull.score.hand.name,
  multiplier: pull.score.hand.multiplier,
  score: pull.score.score,
  cards: pull.cards.map((c) => ({ cardId: c.cardId, isHolo: c.isHolo, ...(c.finish ? { finish: c.finish } : {}), ...(c.misprint ? { misprint: true } : {}) })),
  issue: issue.number,
  // Entries the inbox filed came from Nostr, not from this GitHub account.
  githubUser: issue.user?.login === BOT ? 'nostr' : (issue.user?.login ?? 'unknown'),
  submittedAt: verifiedAt,
});

/** `rejected` marks a refusal that also gets the `rejected` label (a display name that isn't allowed). */
type Checked = { ok: true; entry: HallOfFameEntry; pull: VerifiedPull } | { ok: false; reason: string; rejected?: true };

const checkIssue = async (issue: Issue): Promise<Checked> => {
  const proof = extractProof(issue.body ?? '');
  if (!proof) return { ok: false, reason: 'No pull link found. Paste the link from **Share this pull**.' };
  try {
    const pull = await verifyProof(proof, getSet);
    // The pull stays valid; only publishing it is refused (see isNameAllowed).
    if (!isNameAllowed(pull.proof.name)) {
      return { ok: false, rejected: true, reason: "The pull is real, but its display name isn't allowed in the Hall of Fame. Change your name in Profile, share the pull again, and post the new link in a new issue." };
    }
    if (!qualifiesForHallOfFame(pull.score)) {
      return { ok: false, reason: `The pull is real, but a ${pull.score.hand.name} with a Brainrot Score of ${pull.score.score.toLocaleString('en-US')} doesn't qualify yet (Full House or better, or ${HALL_OF_FAME_MIN_SCORE.toLocaleString('en-US')}+ Brainrot Score).` };
    }
    return { ok: true, entry: toEntry(pull, proof, issue, issue.created_at), pull };
  } catch (error) {
    // The message can contain proof text (e.g. a set id), so it goes through safe().
    return { ok: false, reason: `This pull didn't verify: ${safe(error instanceof Error ? error.message : String(error))}` };
  }
};

const github = async <T>(path: string, token: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}: ${await res.text()}`);
  return (await res.json()) as T;
};

interface Comment {
  body: string | null;
  created_at: string;
  user: { login: string } | null;
}

/** When the bot first verified this pull on this issue (only the bot's own comments count). */
const firstVerifiedAt = async (issue: number, id: string, token: string): Promise<string | null> => {
  for (let page = 1; page < 20; page++) {
    const batch = await github<Comment[]>(`/repos/${REPO}/issues/${issue}/comments?per_page=100&page=${page}`, token);
    const hit = batch.find((c) => c.user?.login === BOT && c.body?.includes(markerFor(id)));
    if (hit) return hit.created_at;
    if (batch.length < 100) return null;
  }
  // Not silent: past this many comments the marker isn't looked for. Not an error either, since
  // anyone can comment, and one busy issue mustn't stop every deploy.
  console.warn(`#${issue}: more than ${19 * 100} comments; stopped looking for the verified marker`);
  return null;
};

/** The bot's latest comment on the issue, or null if there is none or there are too many to read. */
const latestBotComment = async (issue: number, token: string): Promise<Comment | null> => {
  let latest: Comment | null = null;
  for (let page = 1; page < 20; page++) {
    const batch = await github<Comment[]>(`/repos/${REPO}/issues/${issue}/comments?per_page=100&page=${page}`, token);
    for (const c of batch) if (c.user?.login === BOT) latest = c;
    if (batch.length < 100) return latest;
  }
  return null;
};

const FOOTER = '\n\n---\n_Verified automatically by re-deriving the pack from its proof (`scripts/hall-of-fame.ts`)._';

/** The bot's comment on a verified pull; its marker is what `build` looks for. */
const verifiedComment = (entry: HallOfFameEntry, pull: VerifiedPull) =>
  `✅ **Verified!** ${safe(entry.name)} \\#${entry.fingerprint} pulled a **${entry.hand}** in ${safe(entry.setName)} with a Brainrot Score of **${entry.score.toLocaleString('en-US')}**.\n\nIt will appear in the Hall of Fame after the next deploy (started automatically).${FOOTER}\n${markerFor(pullId(pull.proof))}`;

/** Where GitHub Pages serves the site; it always carries hall-of-fame.json, even once the site moves. */
const pagesUrl = () => {
  const [owner, name] = REPO.split('/');
  return `https://${owner}.github.io/${name}/`;
};

/** The list as deployed now, or null if it can't be read (then nothing is held back). */
const publishedList = async (): Promise<(RankableEntry & { issue?: number })[] | null> => {
  try {
    const res = await fetch(`${pagesUrl()}hall-of-fame.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as (Partial<RankableEntry> & { proof?: string })[];
    if (!Array.isArray(data)) return null;
    return data.flatMap((e) => {
      try {
        return [{ ...e, id: e.id ?? pullId(decodeProof(e.proof ?? '')) } as RankableEntry];
      } catch {
        return [];
      }
    });
  } catch {
    return null;
  }
};

const candidateOf = (pull: VerifiedPull) => ({ id: pullId(pull.proof), setId: pull.set.id, score: pull.score });

/** The label for a pull joining the list today (`verified` when the published list can't be read). */
const joinLabel = (pull: VerifiedPull, list: readonly RankableEntry[] | null, day: string): 'verified' | 'daily' =>
  list && hallOfFameJoin(candidateOf(pull), list, day) === 'daily' ? 'daily' : 'verified';

/** Why a verified pull doesn't join the list (all-time or `day`'s top), or null if it does. */
const joinRefusal = (pull: VerifiedPull, list: readonly RankableEntry[], day: string): string | null => {
  const candidate = candidateOf(pull);
  if (hallOfFameJoin(candidate, list, day)) return null;
  if (list.some((e) => e.id === candidate.id)) return 'This pull is already in the Hall of Fame.';
  // Turned down, so the top pulls and the day's top are both full: either bar lets it in.
  const lowest = hallOfFameFloor(list, day) ?? 0;
  return `The pull is real, but the Hall of Fame keeps the top ${HALL_OF_FAME_TOP} and the top ${HALL_OF_FAME_DAILY_TOP} of each UTC day. To join, it needs a Brainrot Score above ${lowest.toLocaleString('en-US')}.`;
};

export const verifyIssue = async () => {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as { issue: Issue };
  let result = await checkIssue(event.issue);
  const token = process.env.GITHUB_TOKEN;
  // An edit that keeps the same verified pull needs no new comment.
  let verifiedAt: string | null = null;
  if (result.ok && token) {
    try {
      verifiedAt = await firstVerifiedAt(event.issue.number, pullId(result.pull.proof), token);
    } catch (error) {
      console.warn(`Could not read earlier comments; treating this as a new verification. ${error}`);
    }
  }
  const already = verifiedAt !== null;
  // A new verification only goes in if it would join the list (the top pulls or today's top), and
  // one that only makes today's top only if it isn't already on an earlier day's. The same pull
  // verified again keeps the label it has.
  let label: 'verified' | 'daily' = isDailyOnly(event.issue) ? 'daily' : 'verified';
  const currentLabels = labelNames(event.issue);
  if (result.ok && !already) {
    const list = await publishedList();
    const day = today();
    const reason = list && joinRefusal(result.pull, list, day);
    if (reason) result = { ok: false, reason };
    else if (joinLabel(result.pull, list, day) === 'verified') label = 'verified';
    else if (token && (await filedDailyElsewhere(result.entry.id, event.issue.number, token))) result = { ok: false, reason: 'This pull is already in the Hall of Fame on a day’s top, and a pull counts on one day only.' };
    else label = 'daily';
  }

  // Only a verified pull can be `already` (a refused one always gets a new comment), so only its
  // labels need checking. `rejected` is the owner's: a repair never relabels, closes or redeploys
  // over it.
  const labelsComplete = (l: 'verified' | 'daily') =>
    currentLabels.includes('hall-of-fame') &&
    currentLabels.includes(l) &&
    !currentLabels.includes('not-verified') &&
    !currentLabels.includes(l === 'daily' ? 'verified' : 'daily');
  const repair = result.ok && already && !labelsComplete(label) && !currentLabels.includes('rejected');
  // One left without `verified` or `daily` (a run that stopped after commenting, or an edit away and
  // back) isn't judged by any day's top again: it is `verified` if it would make the top pulls
  // without this issue's own entry, else `daily` (also when the published list can't be read), so a
  // repair never makes it permanent. A repair redeploys only when the bot's latest comment is this
  // pull's verified one (the run stopped before labelling: an edit away always gets a comment) and
  // the next build would list it while the published list doesn't yet. So editing away and back
  // can't start deploys, even for a pull that isn't live (an expired daily, or one outside the top).
  let redeploy = result.ok && !already;
  if (repair && result.ok && verifiedAt && token) {
    const { id } = result.entry;
    const list = await publishedList();
    const others = list?.filter((e) => e.issue !== event.issue.number) ?? null;
    if (!currentLabels.includes('verified') && !currentLabels.includes('daily')) {
      label = others && hallOfFameJoin(candidateOf(result.pull), others) === 'all-time' ? 'verified' : 'daily';
    }
    if (list && others && !list.some((e) => e.id === id)) {
      const now = new Date();
      const day = utcDay(now.toISOString());
      const counts = label === 'verified' || [day, previousUtcDay(day)].includes(utcDay(verifiedAt));
      const listed = counts && listToPublish([...others, { ...result.entry, submittedAt: verifiedAt }], now).some((e) => e.id === id);
      try {
        redeploy = listed && (await latestBotComment(event.issue.number, token))?.body?.includes(markerFor(id)) === true;
      } catch (error) {
        console.warn(`Could not read the bot's latest comment; not redeploying. ${error}`);
      }
    }
  }
  // `changed` runs the label step; an empty comment file makes it skip the comment.
  const changed = !already || repair;

  const body = result.ok ? verifiedComment(result.entry, result.pull) : `❌ **Not added.** ${result.reason}${FOOTER}`;
  writeFileSync('hof-comment.md', already ? '' : body);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `verified=${result.ok}\nchanged=${changed}\nredeploy=${redeploy}\nlabel=${label}\nrejected=${!result.ok && result.rejected === true}\n`,
    );
  }
  console.log(!already ? body : changed ? `Already verified this pull on this issue; repairing missing labels${redeploy ? ' and redeploying' : ''}.` : 'Already verified this pull on this issue; nothing to do.');
};

/** Pages one issue listing may read (100 issues each). */
export const ISSUE_PAGES = 100;
/** A listing with more issues than it may read: failing beats publishing or deduping against part of it. */
class TooManyIssues extends Error {}

/**
 * Every issue (not pull request) an issue listing returns, all pages. If the last page it may read is
 * still full, it fails rather than leave issues out without a word.
 */
const listIssues = async (query: string, token: string): Promise<Issue[]> => {
  const issues: Issue[] = [];
  for (let page = 1; page <= ISSUE_PAGES; page++) {
    const batch = await github<Issue[]>(`/repos/${REPO}/issues?state=all&${query}&per_page=100&page=${page}`, token);
    issues.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) return issues;
  }
  throw new TooManyIssues(`More than ${ISSUE_PAGES * 100} issues match "${query}"; not reading a partial list`);
};

/** Each issue once, by number. */
const byNumber = (issues: readonly Issue[]) => [...new Map(issues.map((i) => [i.number, i])).values()];

/**
 * Where intake starts reading issues that aren't `verified`: the inbox's relay window and a day (8
 * days), to the second. Deploys read `daily` issues only from the day before on, so this is how far
 * back a pull already on a day's top is kept from counting on another (see "Labels" above).
 */
const recentIssuesSince = () => new Date(Date.now() - (INBOX_WINDOW_S + 24 * 60 * 60) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * The pull id an issue holds, or null if it holds no valid proof or its display name isn't allowed:
 * `build` leaves that entry out, so the pull doesn't count as filed and may be submitted again under
 * a new name.
 */
const listedPullId = (issue: Issue): string | null => {
  const proof = extractProof(issue.body ?? '');
  if (!proof) return null;
  try {
    const decoded = decodeProof(proof);
    return isNameAllowed(decoded.name) ? pullId(decoded) : null;
  } catch {
    return null;
  }
};

/**
 * Whether an issue other than `number` carries pull `id` under the `daily` label and was updated
 * since `recentIssuesSince` (and its display name is allowed, see `listedPullId`). If GitHub can't
 * be read, it says no (as with the published list, nothing is held back).
 */
const filedDailyElsewhere = async (id: string, number: number, token: string): Promise<boolean> => {
  try {
    const issues = await listIssues(`labels=hall-of-fame,daily&since=${recentIssuesSince()}`, token);
    return issues.some((i) => i.number !== number && listedPullId(i) === id);
  } catch (error) {
    console.warn(`Could not list recent daily issues; not checking for this pull on an earlier day. ${error}`);
    return false;
  }
};

/**
 * Issues the bot has verified (it adds the labels; submitters can't add labels themselves): every
 * `verified` one, and the `daily` ones changed since the start of the day before `day` (only those
 * can make the daily tops `build` publishes).
 */
const listVerifiedIssues = async (token: string, day: string): Promise<Issue[]> =>
  byNumber([
    ...(await listIssues('labels=hall-of-fame,verified', token)),
    ...(await listIssues(`labels=hall-of-fame,daily&since=${previousUtcDay(day)}T00:00:00Z`, token)),
  ]);

/** Each verified issue's result as of its last change (see `build`). */
const BUILD_CACHE = 'hof-build-cache.json';
type BuildCache = Record<string, { updatedAt: string; entry: HallOfFameEntry | null; reason?: string }>;

/**
 * What `build` publishes: the top pulls and the daily top of the build's UTC day and the day before
 * (Rankings' "Today", and yesterday's best just after midnight), at most HALL_OF_FAME_MAX_ENTRIES.
 * The first verification of a pull keeps the credit. Daily entries only add to the list, so intake
 * (wouldJoinHallOfFame) and older clients read the same top pulls as before.
 */
export const listToPublish = <T extends RankableEntry>(verified: readonly T[], now = new Date()): T[] => {
  const today = utcDay(now.toISOString());
  return hallOfFameList(verified, [today, previousUtcDay(today)]);
};

export const build = async (output = OUTPUT) => {
  const now = new Date();
  const day = utcDay(now.toISOString());
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (!existsSync(output)) writeFileSync(output, '[]\n');
    console.log('No GITHUB_TOKEN; keeping the existing hall-of-fame.json');
    return;
  }
  let issues: Issue[];
  try {
    issues = (await listVerifiedIssues(token, day)).filter((i) => !labelNames(i).includes('rejected'));
  } catch (error) {
    if (error instanceof TooManyIssues) throw error; // fail the deploy rather than drop entries
    // Don't block a deploy on the Issues API: the committed file is still a verified snapshot.
    if (!existsSync(output)) writeFileSync(output, '[]\n');
    console.warn(`Could not list Hall of Fame issues; keeping the existing hall-of-fame.json. ${error}`);
    return;
  }
  // A pull's pack can't change, so an issue untouched since the last deploy (same updated_at: no
  // edit, comment or label since) keeps its result. The cache's key covers the engine, the sets and
  // this script, so a change to any of them checks everything again.
  const cache: BuildCache = existsSync(BUILD_CACHE) ? (JSON.parse(readFileSync(BUILD_CACHE, 'utf8')) as BuildCache) : {};
  const next: BuildCache = {};
  const verified: HallOfFameEntry[] = [];
  let reused = 0;
  for (const issue of issues) {
    const hit = cache[issue.number];
    if (hit && hit.updatedAt === issue.updated_at) {
      next[issue.number] = hit;
      reused++;
      if (hit.entry) verified.push(hit.entry);
      continue;
    }
    const result = await checkIssue(issue);
    if (!result.ok) {
      next[issue.number] = { updatedAt: issue.updated_at, entry: null, reason: result.reason };
      console.log(buildSkipLine(issue.number, result.reason));
      continue;
    }
    const verifiedAt = await firstVerifiedAt(issue.number, result.entry.id, token);
    if (!verifiedAt) {
      next[issue.number] = { updatedAt: issue.updated_at, entry: null, reason: 'not verified on the issue yet' };
      console.log(`#${issue.number}: skipped (the bot hasn't verified this pull on the issue yet)`);
      continue;
    }
    const entry = { ...result.entry, submittedAt: verifiedAt };
    next[issue.number] = { updatedAt: issue.updated_at, entry };
    verified.push(entry);
  }
  writeFileSync(BUILD_CACHE, JSON.stringify(next));
  // A `daily` pull only counts on the day it was verified (an older one listed because it changed
  // since yesterday stays out).
  const days = [day, previousUtcDay(day)];
  const dailyOnly = new Set(issues.filter(isDailyOnly).map((i) => i.number));
  const counted = verified.filter((e) => !dailyOnly.has(e.issue) || days.includes(utcDay(e.submittedAt)));
  const entries = listToPublish(counted, now);
  for (const e of entries) console.log(`#${e.issue}: ${e.hand} (${e.score}), verified ${e.submittedAt}`);
  writeFileSync(output, JSON.stringify(entries, null, 1) + '\n');
  console.log(`${issues.length} verified issues (${reused} unchanged since the last deploy) -> ${entries.length} entries in public/hall-of-fame.json`);
};

export const SEEN_PATH = 'hof-inbox-seen.json';
/** Per relay, the ranges of the window read through and handled (see Ranges in scripts/hof-inbox.ts). */
export const READ_PATH = 'hof-inbox-read.json';
/** How far back to read the relays. Seen events are skipped, so a long window only costs a download. */
export const INBOX_WINDOW_S = 7 * 24 * 60 * 60;
/** Pulls re-derived per run (about 0.1 s each), so a flood of submissions can't run the job forever. */
export const INBOX_BUDGET = 300;
/** Entries filed per run (two GitHub requests each), well under GitHub's limits on creating content. */
export const INBOX_MAX_FILED = 20;
/**
 * Events per request. Relays advertise their own maximum (NIP-11 `max_limit`), and asking for more
 * can get the connection dropped: relay.nostr.net allows 100, and relay.damus.io hangs up at 500.
 */
export const INBOX_PAGE_SIZE = 100;
/**
 * Requests per relay for older events, so a burst of junk can't push real submissions out of reach.
 * Each run reads this many pages from the newest down, and as many again from one range it hasn't
 * read through (READ_PATH): the newest in even UTC hours, the oldest in odd ones. A read that fails
 * keeps the pages it finished, so a backlog bigger than the cap is read over several runs.
 */
export const INBOX_PAGES = 50;
/**
 * Handled event ids remembered between runs. Each is kept while its event is in the read window, so
 * this is only a bound on the cache (about 8 MB): twice what one run can read (two reads of 50 pages
 * of 100 from each of five relays), and well above a week of #225's expected traffic.
 */
export const INBOX_SEEN_CAP = 100_000;

/** Where players open the site (SITE_URL once it moves off GitHub Pages; the old address redirects). */
const siteUrl = () => process.env.SITE_URL ?? pagesUrl();

export const inbox = async (ticketFn?: TicketFn) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('inbox needs GITHUB_TOKEN to file issues');
  const nowS = Math.floor(Date.now() / 1000);
  // Handled event ids with their events' times, so each is kept until it leaves the read window.
  const seenAt = existsSync(SEEN_PATH) ? parseSeenCache(readFileSync(SEEN_PATH, 'utf8'), nowS) : new Map<string, number>();
  const seen = new Set(seenAt.keys());

  const since = nowS - INBOX_WINDOW_S;
  const filter = { kinds: [HOF_KIND], '#t': [HOF_TAG], since, limit: INBOX_PAGE_SIZE };
  const head = await fetchEvents(filter, undefined, 60000, undefined, INBOX_PAGES);
  for (const r of head.perRelay) console.log(relayReadLine(r));
  // Nothing was read, so a run that carried on would look fine while unread events age out of the
  // window. Fail it instead; the seen cache and what was read through are left as they were.
  if (everyRelayFailed(head.perRelay)) throw new Error(`every relay failed (${head.perRelay.length} of ${head.perRelay.length}); nothing was read`);
  // Then, from each relay that answered, an older range not yet read through: the page cap stopped
  // this run or an earlier one above it. The newest pages are always read again above, so nothing
  // published late is skipped. In even hours (UTC) that is the newest such range, so a burst is read on
  // down from where the cap stopped; in odd hours the oldest, so under steady overload an older range
  // isn't left until it leaves the window, and one a relay can't page past doesn't hold up the rest.
  const gapFor = Math.floor(nowS / 3600) % 2 === 0 ? newestGap : oldestGap;
  const readBefore = existsSync(READ_PATH) ? parseReadRanges(readFileSync(READ_PATH, 'utf8'), head.perRelay.map((r) => r.relay)) : new Map<string, Ranges>();
  const readNow = new Map(head.perRelay.map((r) => [r.relay, rangeRead(r, since, nowS)]));
  const older = await Promise.all(
    head.perRelay.map(async (r) => {
      const gap = r.error === undefined ? gapFor(addRanges(readBefore.get(r.relay) ?? [], readNow.get(r.relay)!), since, nowS) : undefined;
      if (!gap) return [];
      const [lo, hi] = gap;
      const read = await fetchEvents({ ...filter, since: lo, until: hi }, [r.relay], 60000, undefined, INBOX_PAGES);
      console.log(olderReadLine(read.perRelay[0], hi));
      readNow.set(r.relay, addRanges(readNow.get(r.relay)!, rangeRead(read.perRelay[0], lo, hi)));
      return read.events;
    }),
  );
  const events = [...new Map([...head.events, ...older.flat()].map((e) => [e.id, e])).values()];

  // Pulls already in the Hall of Fame: only verified issues count (`verified`, or `daily`), so an
  // issue that never verified (wrong title, a failed run, or a copy someone opened to block it) can't
  // keep a pull out. Every `verified` issue is read; for the rest, the ones changed within the relay
  // window and a day: a `daily` pull or an unfinished issue from the events read now is among them.
  // An issue whose display name isn't allowed counts as neither (see `listedPullId`).
  const filed = new Set<string>();
  // Issues this job opened but didn't finish (it stopped before labelling them): finished next.
  const unfinished = new Map<string, Issue>();
  const listed = byNumber([...(await listIssues('labels=hall-of-fame,verified', token)), ...(await listIssues(`labels=hall-of-fame&since=${recentIssuesSince()}`, token))]);
  for (const issue of listed) {
    const id = listedPullId(issue);
    if (!id) continue; // no valid proof, or a name that's out of the list; nothing to dedupe against
    if (labelNames(issue).includes('verified') || labelNames(issue).includes('daily')) filed.add(id);
    else if (issue.user?.login === BOT && !unfinished.has(id)) unfinished.set(id, issue);
  }

  // Only pulls that would join the list are filed; each one filed raises the bar for the next. Each
  // pull is judged by the UTC day its entry is stamped with: its unfinished issue's, or else today's
  // (a new issue is stamped as it opens), so after midnight a run judges by the new day's top. The
  // floor is today's, so it doesn't apply to an unfinished issue, which may be judged by an earlier day.
  const list = await publishedList();
  if (!list) console.log("Couldn't read the published list; filing every qualifying pull");
  const stampDay = (pull: VerifiedPull) => utcDay(unfinished.get(pullId(pull.proof))?.created_at ?? new Date().toISOString());

  const { added, deferred } = await processInbox(events, {
    seen,
    filed,
    accepts: (pull) => (list ? joinRefusal(pull, list, stampDay(pull)) === null : qualifiesForHallOfFame(pull.score)),
    floor: (id) => (list && !unfinished.has(id) ? hallOfFameFloor(list, today()) : null),
    budget: INBOX_BUDGET,
    maxFiled: INBOX_MAX_FILED,
    lookup: getSet,
    ticketFn,
    log: console.log,
    // Filed by the bot, so the issue-opened workflow doesn't run on it again; the marker comment is
    // the "first verified" time, exactly as for issues people open themselves. The marker goes on
    // before the `verified` (or `daily`) label (`build` only reads labelled issues), and a run that
    // stops between steps finishes the same issue next time rather than opening another.
    file: async (proof, pull, event) => {
      const id = pullId(pull.proof);
      const earlier = unfinished.get(id);
      const issue =
        earlier ??
        (await github<Issue>(`/repos/${REPO}/issues`, token, {
          title: `[Hall of Fame] ${pull.score.hand.name} by ${safe(publicName(pull.proof.name))}`,
          body: `${siteUrl()}#/pull/${proof}\n\nSubmitted without a GitHub account, through public Nostr relays (event \`${event.id}\`).`,
          labels: ['hall-of-fame'],
        }));
      const entry = toEntry(pull, proof, issue, issue.created_at);
      if (!earlier || !(await firstVerifiedAt(issue.number, id, token))) {
        await github(`/repos/${REPO}/issues/${issue.number}/comments`, token, { body: verifiedComment(entry, pull) });
      }
      await github(`/repos/${REPO}/issues/${issue.number}/labels`, token, { labels: [joinLabel(pull, list, utcDay(issue.created_at))] });
      unfinished.delete(id);
      // Done: closed issues stay in the Hall of Fame (the deploy reads every state); this keeps the
      // issue list for things that need attention.
      try {
        await github(`/repos/${REPO}/issues/${issue.number}`, token, { state: 'closed', state_reason: 'completed' }, 'PATCH');
      } catch (error) {
        console.warn(`#${issue.number}: filed, but couldn't close it: ${error}`);
      }
      list?.push(entry);
      console.log(`#${issue.number}: ${entry.hand} (${entry.score}) from Nostr event ${event.id}`);
    },
  });
  if (deferred) console.log(`${deferred} events left for the next run`);

  for (const event of events) seenAt.set(event.id, event.created_at);
  writeFileSync(SEEN_PATH, seenCacheText(seen, seenAt, since, nowS, INBOX_SEEN_CAP));
  // Read through: what was read now and handled, below the first event left for the next run.
  const handledTo = deferredFrom(events, deferred) - 1;
  const readAfter = head.perRelay.map((r) => [r.relay, clipRanges(addRanges(readBefore.get(r.relay) ?? [], clipRanges(readNow.get(r.relay)!, since, handledTo)), since, nowS)]);
  writeFileSync(READ_PATH, JSON.stringify(Object.fromEntries(readAfter)));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `added=${added}\n`);
  console.log(`${events.length} events read, ${added} added`);
};

/**
 * Which relays work from here: each is sent a throwaway event (its own tag, expires in an hour) and
 * asked for it back. Run from the inbox workflow (input `probe`) to check relays from GitHub's runners.
 */
const probe = async (relays: string[]) => {
  const event = probeEvent();
  const sent = await publishEvent(event, relays, 10000);
  const read = await fetchEvents({ ids: [event.id], kinds: [HOF_KIND] }, relays, 10000);
  for (const [i, relay] of relays.entries()) console.log(probeLine(relay, sent[i], read.perRelay[i]));
};

// Run as a script; tests import the modes and run them against fixtures (scripts/hall-of-fame.test.ts).
if (isMainModule(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'verify-issue') await verifyIssue();
  else if (mode === 'inbox') await inbox();
  else if (mode === 'probe') await probe(process.argv.length > 3 ? process.argv.slice(3) : HOF_RELAYS);
  else if (mode === 'build') await build();
  else {
    console.error('Usage: npx tsx scripts/hall-of-fame.ts <verify-issue|inbox|build|probe [relays...]>');
    process.exit(2);
  }
}
