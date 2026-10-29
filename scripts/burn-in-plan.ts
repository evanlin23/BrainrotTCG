import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from './main-module.ts';

/**
 * Which browser specs the burn-in job (.github/workflows/browser-tests.yml) repeats, and how often.
 *
 * - A spec burns in when the branch adds or changes it, or changes a helper under tests/browser it
 *   imports (directly or through other helpers).
 * - Changes to playwright.config.ts or to app code burn in nothing. The regular shards still run
 *   every spec once.
 * - The repeat count shrinks as the list grows, so the job's length has a fixed bound:
 *   - `BURN_IN_BUDGET` spec runs per project when that is enough;
 *   - never fewer than `MIN_REPEATS` per spec. Over the budget the job takes longer but never
 *     drops a spec;
 *   - every spec at `MIN_REPEATS` is the longest the job can take: twice the whole suite, split
 *     over the job's 3 shards.
 */
export const BURN_IN_BUDGET = 40;
export const MIN_REPEATS = 2;
export const MAX_REPEATS = 10;

export const BROWSER_DIR = 'tests/browser';

export interface BurnInPlan { specs: string[]; repeat: number }

const isSpec = (file: string) => file.startsWith(`${BROWSER_DIR}/`) && file.endsWith('.spec.ts');
const isHelper = (file: string) => file.startsWith(`${BROWSER_DIR}/`) && file.endsWith('.ts') && !file.endsWith('.spec.ts');

/**
 * Does this source import the helper at `helper` (a path like tests/browser/support.ts)?
 * Matches both `from './helper'` and `from './helper.ts'`.
 */
export const importsHelper = (source: string, helper: string): boolean => {
  const name = path.posix.basename(helper, '.ts').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`from\\s+['"]\\./${name}(\\.ts)?['"]`).test(source);
};

/** How many times to repeat each of `count` specs. */
export const repeatsFor = (count: number): number =>
  Math.max(MIN_REPEATS, Math.min(MAX_REPEATS, Math.floor(BURN_IN_BUDGET / Math.max(count, 1))));

/**
 * The plan for a branch.
 * - `changed`: the files it adds or changes, deletions left out.
 * - `specSources`: every spec that exists now, keyed by path, with its source.
 * - `helperSources`: helper files under tests/browser that exist now, keyed by path, with their source.
 */
export const planBurnIn = (
  changed: readonly string[],
  specSources: ReadonlyMap<string, string>,
  helperSources?: ReadonlyMap<string, string>,
): BurnInPlan => {
  const helpers: ReadonlyMap<string, string> =
    helperSources ?? new Map([...specSources].filter(([file]) => isHelper(file)));

  // Transitive closure of affected helpers: all changed helpers plus any helper that
  // directly or indirectly imports an affected helper.
  const affectedHelpers = new Set(changed.filter(isHelper));
  const queue = [...affectedHelpers];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [helperFile, helperSource] of helpers) {
      if (!affectedHelpers.has(helperFile) && importsHelper(helperSource, current)) {
        affectedHelpers.add(helperFile);
        queue.push(helperFile);
      }
    }
  }

  const picked = new Set(changed.filter((file) => isSpec(file) && specSources.has(file)));
  for (const helper of affectedHelpers) {
    for (const [spec, source] of specSources) {
      if (isSpec(spec) && importsHelper(source, helper)) picked.add(spec);
    }
  }
  const specs = [...picked].sort();
  return { specs, repeat: specs.length ? repeatsFor(specs.length) : 0 };
};

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();

// CLI: `tsx scripts/burn-in-plan.ts <base ref>`. Compares HEAD with its merge base on that ref and
// writes `specs` (space-separated) and `repeat` to $GITHUB_OUTPUT, or prints them.
if (isMainModule(import.meta.url)) {
  const base = process.argv[2];
  if (!base) throw new Error('usage: tsx scripts/burn-in-plan.ts <base ref>');
  const changed = git('diff', '--name-only', '--diff-filter=d', git('merge-base', base, 'HEAD'), 'HEAD').split('\n').filter(Boolean);
  const browserFiles = readdirSync(BROWSER_DIR).map((name) => `${BROWSER_DIR}/${name}`);
  const specSources = new Map(
    browserFiles
      .filter((file) => isSpec(file))
      .map((file) => [file, readFileSync(file, 'utf8')] as const),
  );
  const helperSources = new Map(
    browserFiles
      .filter((file) => isHelper(file))
      .map((file) => [file, readFileSync(file, 'utf8')] as const),
  );
  const { specs, repeat } = planBurnIn(changed, specSources, helperSources);
  console.log(specs.length ? `Burn-in: ${specs.length} spec(s), ${repeat} repeats each:\n${specs.join('\n')}` : 'Burn-in: no spec or browser helper changed');
  const lines = [`specs=${specs.join(' ')}`, `repeat=${repeat}`];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));
}
