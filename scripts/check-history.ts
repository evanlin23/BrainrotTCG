/**
 * Keeps the proof corpus append-only: every vector and set lock a base commit had must still be in
 * the working tree, unchanged (docs/ARCHITECTURE.md, Vectors and set locks).
 *
 *   npm run check:history                   compare with the merge base of HEAD and origin/main
 *   npm run check:history -- --base <rev>   compare with <rev> (CI passes the commit it merges onto)
 *
 * The base files are read as data with `git show <rev>:<file>` and JSON.parse: nothing from the base
 * is imported or run, and no network or token is used. In each file, every top-level field of the
 * base must still be there. A list keeps all its old entries, unchanged and in the same order, and
 * may gain new ones anywhere; any other value must be identical. New top-level fields are allowed.
 * Whitespace, indentation and key order inside objects don't matter. Every number must be a safe
 * integer written the way JavaScript prints it, so no two different texts parse to one value.
 *
 * The one exception: an old list entry named in spec/retired-vectors.json (read from the working
 * tree, reviewed with the change that retires it, and printed loudly) may go. Retiring one needs the
 * owner's sign-off (docs/ARCHITECTURE.md, Protocol changes).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.ts';

export const HISTORY_FILES = ['spec/vectors.json', 'spec/vectors-python.json', 'src/content/sets.lock.json'] as const;

/** Old list entries allowed to go, each by the SHA-256 of its canonical form. Read from the working tree. */
export const RETIRED_FILE = 'spec/retired-vectors.json';

export type Retirement = { file: string; list: string; sha256: string; reason: string; approvedIn: string };

/** The base files are a few hundred KB; refuse anything far larger rather than buffer it. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One string per JSON value, the same whatever its whitespace or key order. List order counts. */
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

/** The id spec/retired-vectors.json names an entry by. */
export const entryId = (entry: unknown): string => createHash('sha256').update(canonical(entry)).digest('hex');

const describe = (entry: unknown): string => {
  const text = canonical(entry);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

/**
 * Finds the old list's entries in the new list, in order. Greedy matching is exact for this: if the
 * old list is a subsequence of the new one, taking the first match each time finds it.
 */
const compareList = (file: string, key: string, base: Json[], candidate: Json[], retired: readonly Retirement[], notes: string[]): string[] => {
  const keys = candidate.map(canonical);
  const wants = base.map(canonical);
  const copies = (list: string[], want: string) => list.filter((k) => k === want).length;
  let next = 0;
  for (const [index, entry] of base.entries()) {
    const want = wants[index];
    const retirement = retired.find((r) => r.file === file && r.list === key && r.sha256 === entryId(entry));
    if (retirement) {
      notes.push(`${file}: ${key}[${index}] RETIRED (${retirement.reason}; approved in ${retirement.approvedIn}). Entry: ${describe(entry)}`);
      continue;
    }
    const found = keys.indexOf(want, next);
    if (found === -1) {
      // Fewer copies than the base had means one went; as many means they are out of order.
      const moved = copies(keys, want) >= copies(wants, want);
      return [
        moved
          ? `${file}: ${key}[${index}] moved before an entry that came earlier in the base; old entries keep their order. Entry: ${describe(entry)}`
          : `${file}: ${key}[${index}] was removed or changed; old entries must stay exactly as they were. Base entry: ${describe(entry)}`,
      ];
    }
    next = found + 1;
  }
  return [];
};

/** What the candidate lost or changed from the base, as messages; empty when it kept everything. */
export const compareCorpus = (
  file: string,
  base: unknown,
  candidate: unknown,
  retired: readonly Retirement[] = [],
  notes: string[] = [],
): string[] => {
  if (!isObject(base)) return [`${file}: the base is not a JSON object, so it can't be compared`];
  if (!isObject(candidate)) return [`${file}: is no longer a JSON object`];
  const errors: string[] = [];
  for (const [key, old] of Object.entries(base)) {
    if (!Object.hasOwn(candidate, key)) {
      errors.push(`${file}: ${key} was removed`);
      continue;
    }
    const now = candidate[key];
    if (Array.isArray(old)) {
      if (Array.isArray(now)) errors.push(...compareList(file, key, old, now, retired, notes));
      else errors.push(`${file}: ${key} is no longer a list`);
    } else if (canonical(old) !== canonical(now)) {
      errors.push(`${file}: ${key} changed from ${describe(old)} to ${describe(now)}`);
    }
  }
  return errors;
};

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_FILE_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });

/** The commit `rev` names, or an error saying how to make it available. */
export const resolveBase = (root: string, rev: string): string => {
  if (!rev || rev.startsWith('-')) throw new Error(`Invalid base revision ${JSON.stringify(rev)}`);
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]).trim();
  } catch {
    throw new Error(
      `Base ${rev} is not available in this checkout. Fetch it first (a shallow clone has no history: ` +
        `git fetch --no-tags --depth=1 origin <commit>), or pass --base with a commit you have.`,
    );
  }
};

/** The merge base of HEAD and origin/main, for local runs. */
export const defaultBase = (root: string): string => {
  try {
    return git(root, ['merge-base', 'HEAD', 'origin/main']).trim();
  } catch {
    throw new Error('No base: origin/main is missing or shares no history with HEAD. Run git fetch origin main, or pass --base <rev>.');
  }
};

/**
 * JSON.parse reads numbers as doubles, so 1, 1.0 and 1e0 would compare equal, and so would two
 * integers above 2^53. Refuse any number that isn't a safe integer in its canonical text.
 */
const exactNumber = (_key: string, value: unknown, context?: { source?: string }): unknown => {
  if (typeof value === 'number' && !(Number.isSafeInteger(value) && context?.source === String(value))) {
    throw new RangeError(`the number ${context?.source ?? value} is not a safe integer written canonically, so it can't be compared exactly`);
  }
  return value;
};

export const parseCorpus = (text: string, where: string): unknown => {
  try {
    return JSON.parse(text, exactNumber);
  } catch (error) {
    const why = error instanceof SyntaxError ? 'is not valid JSON' : 'is refused';
    throw new Error(`${where} ${why}: ${(error as Error).message}`, { cause: error });
  }
};

/** The retirements in the working tree's spec/retired-vectors.json, checked strictly; [] without one. */
export const readRetired = (root: string, files: readonly string[]): Retirement[] => {
  let text: string;
  try {
    text = readFileSync(`${root}/${RETIRED_FILE}`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const value = parseCorpus(text, RETIRED_FILE);
  const list = isObject(value) ? value.retired : undefined;
  if (!Array.isArray(list)) throw new Error(`${RETIRED_FILE} must be an object with a "retired" list`);
  const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  return list.map((item, index) => {
    const ok =
      isObject(item) &&
      Object.keys(item).sort().join() === 'approvedIn,file,list,reason,sha256' &&
      files.includes(item.file as string) &&
      nonEmpty(item.list) &&
      /^[0-9a-f]{64}$/.test(item.sha256 as string) &&
      nonEmpty(item.reason) &&
      nonEmpty(item.approvedIn);
    if (!ok) {
      throw new Error(
        `${RETIRED_FILE}: retired[${index}] must have exactly file (one of ${files.join(', ')}), list, sha256 (64 hex), reason and approvedIn`,
      );
    }
    return item as Retirement;
  });
};

/** Compares each history file at `base` with the working tree under `root`. Retired entries go to `notes`. */
export const checkHistory = (root: string, base: string, files: readonly string[] = HISTORY_FILES, notes: string[] = []): string[] => {
  const commit = resolveBase(root, base);
  const retired = readRetired(root, files);
  const errors: string[] = [];
  for (const file of files) {
    let baseText: string;
    try {
      baseText = git(root, ['show', `${commit}:${file}`]);
    } catch {
      errors.push(`${file}: missing at base ${commit}, so there's nothing to compare with. Pass the base that has it.`);
      continue;
    }
    let candidateText: string;
    try {
      candidateText = readFileSync(`${root}/${file}`, 'utf8');
    } catch {
      errors.push(`${file}: was deleted; old proofs and locks depend on it`);
      continue;
    }
    errors.push(...compareCorpus(file, parseCorpus(baseText, `${file} at ${commit}`), parseCorpus(candidateText, file), retired, notes));
  }
  return errors;
};

if (isMainModule(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const at = process.argv.indexOf('--base');
  try {
    const base = at === -1 ? defaultBase(root) : (process.argv[at + 1] ?? '');
    const notes: string[] = [];
    const errors = checkHistory(root, base, HISTORY_FILES, notes);
    if (notes.length) {
      console.warn(`!!! ${notes.length} old entr${notes.length === 1 ? 'y is' : 'ies are'} RETIRED by ${RETIRED_FILE}. Each needs the owner's sign-off:`);
      console.warn(notes.map((n) => `!!! ${n}`).join('\n'));
    }
    if (errors.length) {
      console.error(errors.map((e) => `✗ ${e}`).join('\n'));
      console.error('Old vectors and locks are history. Add new cases or a new version instead (docs/ARCHITECTURE.md).');
      process.exit(1);
    }
    console.log(`✓ ${HISTORY_FILES.length} history file(s) keep everything from ${base}`);
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(1);
  }
}
