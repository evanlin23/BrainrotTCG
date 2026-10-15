/**
 * The global Hall of Fame, with GitHub Issues as the database and this script
 * as the verifier. Nothing is trusted: every proof is re-derived from scratch.
 *
 *   npx tsx scripts/hall-of-fame.ts verify-issue   (Actions, on an issue event)
 *     Reads the issue from $GITHUB_EVENT_PATH, verifies its pull link and writes
 *     hof-comment.md plus `verified`, `changed` to $GITHUB_OUTPUT. A verified
 *     comment carries a marker with the pull id.
 *
 *   npx tsx scripts/hall-of-fame.ts inbox           (Actions, on a schedule)
 *     Reads submissions sent without a GitHub account through public Nostr relays
 *     (src/game/nostrInbox.ts), verifies each pull, and files every one that
 *     qualifies as a bot-authored Hall of Fame issue with the same verified
 *     marker, so `build` treats it like any other entry. Writes `added` to
 *     $GITHUB_OUTPUT. Event ids it has seen are kept in hof-inbox-seen.json
 *     (cached between runs) so junk isn't re-checked every time.
 *
 *   npx tsx scripts/hall-of-fame.ts build           (deploy, before vite build)
 *     Lists verified Hall of Fame issues, verifies each proof, and writes the
 *     list (the top pulls and each set's firsts, src/engine/hallOfFame.ts) to
 *     public/hall-of-fame.json. Results are kept in hof-build-cache.json (cached
 *     between deploys): an issue unchanged since the last deploy isn't checked
 *     again, so a deploy's cost grows with new submissions, not with all of them.
 *     Without a token, or if GitHub is down, it keeps the existing file.
 *
 * The inbox and the issue verifier only add a pull that would join the list, so
 * the number of entries stays about the same however many people play.
 *
 * "World first" order uses the time the bot first verified that exact pull on
 * the issue (its marker comment), not the issue's creation date: otherwise
 * anyone could open a placeholder issue early and edit a pull in later.
 *
 * Security: issue bodies are untrusted input. They are only ever parsed here,
 * never interpolated into a shell command, and echoed only through safe().
 */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSet } from '../src/content/sets/index.ts';
import {
  decodeProof,
  extractProof,
  HALL_OF_FAME_MIN_MULTIPLIER,
  HALL_OF_FAME_MIN_SCORE,
  HALL_OF_FAME_TOP,
  hallOfFameList,
  pullId,
  qualifiesForHallOfFame,
  topPulls,
  verifyProof,
  wouldJoinHallOfFame,
  type RankableEntry,
  type VerifiedPull,
  type Finish,
} from '../src/engine/index.ts';
import { fetchEvents, HOF_KIND, HOF_RELAYS, HOF_TAG, probeEvent, publishEvent } from '../src/game/nostrInbox.ts';
import { buildSkipLine, probeLine, processInbox, relayReadLine } from './hof-inbox.ts';

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

type Checked = { ok: true; entry: HallOfFameEntry; pull: VerifiedPull } | { ok: false; reason: string };

const checkIssue = async (issue: Issue): Promise<Checked> => {
  const proof = extractProof(issue.body ?? '');
  if (!proof) return { ok: false, reason: 'No pull link found. Paste the link from **Share this pull**.' };
  try {
    const pull = await verifyProof(proof, getSet);
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
    if (batch.length < 100) break;
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
const publishedList = async (): Promise<RankableEntry[] | null> => {
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

/** Why a verified pull doesn't join the list, or null if it does. */
const joinRefusal = (pull: VerifiedPull, list: readonly RankableEntry[]): string | null => {
  const candidate = { id: pullId(pull.proof), setId: pull.set.id, score: pull.score };
  if (wouldJoinHallOfFame(candidate, list)) return null;
  if (list.some((e) => e.id === candidate.id)) return 'This pull is already in the Hall of Fame.';
  const lowest = topPulls(list).at(-1)?.score ?? 0;
  const first = pull.score.hand.multiplier >= HALL_OF_FAME_MIN_MULTIPLIER ? `, or be the first ${pull.score.hand.name} in ${safe(pull.set.name)}` : '';
  return `The pull is real, but the Hall of Fame keeps the top ${HALL_OF_FAME_TOP} and the first of each hand in each set. To join, it needs a Brainrot Score above ${lowest.toLocaleString('en-US')}${first}.`;
};

export const verifyIssue = async () => {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as { issue: Issue };
  let result = await checkIssue(event.issue);
  const token = process.env.GITHUB_TOKEN;
  // An edit that keeps the same verified pull needs no new comment or redeploy.
  let already = false;
  if (result.ok && token) {
    try {
      already = (await firstVerifiedAt(event.issue.number, pullId(result.pull.proof), token)) !== null;
    } catch (error) {
      console.warn(`Could not read earlier comments; treating this as a new verification. ${error}`);
    }
  }
  // A new verification only goes in if it would join the list (the top pulls, or a first).
  if (result.ok && !already) {
    const list = await publishedList();
    const reason = list && joinRefusal(result.pull, list);
    if (reason) result = { ok: false, reason };
  }
  const body = result.ok ? verifiedComment(result.entry, result.pull) : `❌ **Not added.** ${result.reason}${FOOTER}`;
  writeFileSync('hof-comment.md', body);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verified=${result.ok}\nchanged=${!already}\n`);
  console.log(already ? 'Already verified this pull on this issue; nothing to do.' : body);
};

/** Issues the bot has verified (it adds both labels; submitters can't add labels themselves). */
const listVerifiedIssues = async (token: string): Promise<Issue[]> => {
  const issues: Issue[] = [];
  for (let page = 1; page < 100; page++) {
    const batch = await github<Issue[]>(`/repos/${REPO}/issues?state=all&labels=hall-of-fame,verified&per_page=100&page=${page}`, token);
    issues.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
  }
  return issues;
};

/** Each verified issue's result as of its last change (see `build`). */
const BUILD_CACHE = 'hof-build-cache.json';
type BuildCache = Record<string, { updatedAt: string; entry: HallOfFameEntry | null; reason?: string }>;

export const build = async (output = OUTPUT) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (!existsSync(output)) writeFileSync(output, '[]\n');
    console.log('No GITHUB_TOKEN; keeping the existing hall-of-fame.json');
    return;
  }
  let issues: Issue[];
  try {
    issues = (await listVerifiedIssues(token)).filter((i) => !labelNames(i).includes('rejected'));
  } catch (error) {
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
  // The top pulls and each set's firsts; the first verification of a pull keeps the credit.
  const entries = hallOfFameList(verified);
  for (const e of entries) console.log(`#${e.issue}: ${e.hand} (${e.score}), verified ${e.submittedAt}`);
  writeFileSync(output, JSON.stringify(entries, null, 1) + '\n');
  console.log(`${issues.length} verified issues (${reused} unchanged since the last deploy) -> ${entries.length} entries in public/hall-of-fame.json`);
};

const SEEN_PATH = 'hof-inbox-seen.json';
/** How far back to read the relays. Seen events are skipped, so a long window only costs a download. */
const INBOX_WINDOW_S = 7 * 24 * 60 * 60;
/** Pulls re-derived per run (about 0.1 s each), so a flood of submissions can't run the job forever. */
const INBOX_BUDGET = 300;
/** Entries filed per run (two GitHub requests each), well under GitHub's limits on creating content. */
const INBOX_MAX_FILED = 20;
/**
 * Events per request. Relays advertise their own maximum (NIP-11 `max_limit`), and asking for more
 * can get the connection dropped: relay.nostr.net allows 100, and relay.damus.io hangs up at 500.
 */
const INBOX_PAGE_SIZE = 100;
/** Requests per relay for older events, so a burst of junk can't push real submissions out of reach. */
const INBOX_PAGES = 50;

/** Where players open the site (SITE_URL once it moves off GitHub Pages; the old address redirects). */
const siteUrl = () => process.env.SITE_URL ?? pagesUrl();

export const inbox = async () => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('inbox needs GITHUB_TOKEN to file issues');
  const seen = new Set<string>(existsSync(SEEN_PATH) ? (JSON.parse(readFileSync(SEEN_PATH, 'utf8')) as string[]) : []);

  const since = Math.floor(Date.now() / 1000) - INBOX_WINDOW_S;
  const { events, perRelay } = await fetchEvents({ kinds: [HOF_KIND], '#t': [HOF_TAG], since, limit: INBOX_PAGE_SIZE }, undefined, 60000, undefined, INBOX_PAGES);
  for (const r of perRelay) console.log(relayReadLine(r));

  // Pulls already in the Hall of Fame: only verified issues count, so an issue that never verified
  // (wrong title, a failed run, or a copy someone opened to block it) can't keep a pull out.
  const filed = new Set<string>();
  // Issues this job opened but didn't finish (it stopped before labelling them): finished next.
  const unfinished = new Map<string, Issue>();
  for (let page = 1; page < 100; page++) {
    const batch = await github<Issue[]>(`/repos/${REPO}/issues?state=all&labels=hall-of-fame&per_page=100&page=${page}`, token);
    for (const issue of batch) {
      const proof = extractProof(issue.body ?? '');
      if (!proof || issue.pull_request) continue;
      let id: string;
      try {
        id = pullId(decodeProof(proof));
      } catch {
        continue; // not a valid proof; nothing to dedupe against
      }
      if (labelNames(issue).includes('verified')) filed.add(id);
      else if (issue.user?.login === BOT && !unfinished.has(id)) unfinished.set(id, issue);
    }
    if (batch.length < 100) break;
  }

  // Only pulls that would join the list are filed; each one filed raises the bar for the next.
  const list = await publishedList();
  if (!list) console.log("Couldn't read the published list; filing every qualifying pull");

  const { added, deferred } = await processInbox(events, {
    seen,
    filed,
    accepts: (pull) => (list ? joinRefusal(pull, list) === null : qualifiesForHallOfFame(pull.score)),
    budget: INBOX_BUDGET,
    maxFiled: INBOX_MAX_FILED,
    lookup: getSet,
    log: console.log,
    // Filed by the bot, so the issue-opened workflow doesn't run on it again; the marker comment is
    // the "first verified" time, exactly as for issues people open themselves. The marker goes on
    // before the `verified` label (`build` only reads labelled issues), and a run that stops between
    // steps finishes the same issue next time rather than opening another.
    file: async (proof, pull, event) => {
      const id = pullId(pull.proof);
      const earlier = unfinished.get(id);
      const issue =
        earlier ??
        (await github<Issue>(`/repos/${REPO}/issues`, token, {
          title: `[Hall of Fame] ${pull.score.hand.name} by ${safe(pull.proof.name) || 'Anonymous'}`,
          body: `${siteUrl()}#/pull/${proof}\n\nSubmitted without a GitHub account, through public Nostr relays (event \`${event.id}\`).`,
          labels: ['hall-of-fame'],
        }));
      const entry = toEntry(pull, proof, issue, issue.created_at);
      if (!earlier || !(await firstVerifiedAt(issue.number, id, token))) {
        await github(`/repos/${REPO}/issues/${issue.number}/comments`, token, { body: verifiedComment(entry, pull) });
      }
      await github(`/repos/${REPO}/issues/${issue.number}/labels`, token, { labels: ['verified'] });
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

  // Keep the cache bounded; the newest ids matter (older events fall out of the window anyway).
  writeFileSync(SEEN_PATH, JSON.stringify([...seen].slice(-20000)));
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
// Both sides are real paths, so it still runs when started through a symlink.
const isMainModule = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMainModule) {
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
