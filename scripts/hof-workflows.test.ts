// Offline contracts for the workflows that touch the Hall of Fame, the ones a fork pull request can
// start, the nightly test-order run and the ops-health report. Read as text (there's no YAML parser here), so this only covers the shape these files
// already have: two-space indents, block-style `permissions`, one job per `  name:` line. A few steps'
// shells also run here, against a fake `gh`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILED_PATH, READ_PATH, SEEN_PATH } from './hall-of-fame.ts';
import { CONDITIONS, INBOX_PROBE_TITLE, type ConditionKey } from './ops-health';

const read = (name: string) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

/** Lines up to the first one that is less indented than `indent` (blank and comment lines kept). */
const block = (lines: string[], from: number, indent: number) => {
  const out: string[] = [];
  for (const line of lines.slice(from)) {
    if (line.trim() && !line.trim().startsWith('#') && line.search(/\S/) < indent) break;
    out.push(line);
  }
  return out;
};

/** The `on:` section, before the next top-level key. */
const triggers = (text: string) => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^on:/.test(l));
  return [lines[at], ...block(lines, at + 1, 1)].join('\n');
};

const pairs = (lines: string[]) =>
  Object.fromEntries(
    lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(':').map((s) => s.trim()) as [string, string]),
  );

/** The top-level `permissions:` value: `{}` or `scope: level` pairs. */
const topPermissions = (text: string): string | Record<string, string> => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^permissions:/.test(l));
  expect(at, 'top-level permissions').toBeGreaterThanOrEqual(0);
  const inline = lines[at].slice('permissions:'.length).trim();
  return inline || pairs(block(lines, at + 1, 1));
};

/** Each job's text, keyed by its id. */
const jobs = (text: string) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:/.test(l));
  const out: Record<string, string[]> = {};
  lines.slice(start + 1).forEach((line, i) => {
    const id = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (id) out[id] = block(lines, start + 2 + i, 4);
  });
  return out;
};

/** A job's own `permissions:` pairs, or null if it has none. */
const jobPermissions = (job: string[]): string | Record<string, string> | null => {
  const at = job.findIndex((l) => /^ {4}permissions:/.test(l));
  if (at < 0) return null;
  const inline = job[at].trim().slice('permissions:'.length).trim();
  return inline ? inline : pairs(block(job, at + 1, 6));
};

/** Every `run:` command, with its continuation lines. */
const runCommands = (text: string) => {
  const lines = text.split('\n');
  return lines.flatMap((line, i) => {
    const m = /^(\s*(?:- )?)run:/.exec(line);
    if (!m) return [];
    // Continuation lines sit deeper than the `run` key itself, not just deeper than the dash.
    return [[line, ...block(lines, i + 1, m[1].length + 1)].join('\n')];
  });
};

/** The job's steps, each from its `- ` line up to the next step or comment at step level. */
const steps = (job: string[]) => {
  const out: string[][] = [];
  let open = false;
  for (const line of job) {
    if (/^ {6}- /.test(line)) {
      out.push([line]);
      open = true;
    } else if (open && (!line.trim() || /^ {8}/.test(line))) out[out.length - 1].push(line);
    else open = false;
  }
  return out.map((s) => s.join('\n'));
};

/** The step whose script contains `needle`, and that script dedented as the runner writes it to a file. */
const stepScript = (job: string[], needle: string) => {
  const step = steps(job).find((s) => runCommands(s).some((r) => r.includes(needle)));
  expect(step, `step running ${needle}`).toBeDefined();
  const lines = runCommands(step!)[0].split('\n').slice(1);
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return { step: step!, script: lines.map((l) => l.slice(indent)).join('\n') };
};

/**
 * bash's arguments for a step, as GitHub documents them for Linux runners: `shell: bash` runs
 * `bash --noprofile --norc -eo pipefail {0}`, no `shell:` runs `bash -e {0}`, without pipefail.
 */
const bashArgs = (step: string) => {
  const shell = /^ {8}shell:\s*(\S+)/m.exec(step)?.[1];
  if (shell === undefined) return ['-e'];
  expect(shell, 'only bash steps are run here').toBe('bash');
  return ['--noprofile', '--norc', '-eo', 'pipefail'];
};

describe('Hall of Fame workflows (offline contracts)', () => {
  const expected: Record<string, Record<string, Record<string, string>>> = {
    'hall-of-fame.yml': {
      verify: { contents: 'read', issues: 'write' },
      redeploy: { actions: 'write' },
    },
    'hall-of-fame-inbox.yml': {
      probe: { contents: 'read' },
      inbox: { contents: 'read', issues: 'write' },
      redeploy: { actions: 'write' },
    },
  };

  for (const [file, want] of Object.entries(expected)) {
    describe(file, () => {
      const text = read(file);

      it('is never started by a pull request, from a fork or not', () => {
        expect(triggers(text)).not.toMatch(/pull_request/);
      });

      it('grants nothing by default and each job only the scopes it uses', () => {
        expect(topPermissions(text)).toBe('{}');
        const all = jobs(text);
        expect(Object.keys(all).sort()).toEqual(Object.keys(want).sort());
        for (const [id, scopes] of Object.entries(want)) expect(jobPermissions(all[id]), id).toEqual(scopes);
      });

      it('keeps the job that can start a deploy away from the repository code', () => {
        for (const [id, job] of Object.entries(jobs(text))) {
          const scopes = jobPermissions(job);
          if (typeof scopes === 'object' && scopes?.actions === 'write') {
            expect(job.join('\n'), id).not.toMatch(/actions\/checkout/);
          }
        }
      });

      it('uses no secrets and never puts submitted text into a command', () => {
        expect(text).not.toMatch(/secrets\./);
        expect(text).not.toMatch(/github\.event\.issue\.(body|title)\s*}}/);
        for (const run of runCommands(text)) expect(run).not.toContain('${{');
      });
    });
  }

  it('closes only what verify-issue calls a duplicate (#21)', () => {
    expect(jobs(read('hall-of-fame.yml')).verify.join('\n')).toContain('DUPLICATE: ${{ steps.check.outputs.duplicate }}');
  });

  it('labels a pull refused for its display name `rejected`, and never takes that label off', () => {
    const verify = jobs(read('hall-of-fame.yml')).verify.join('\n');
    expect(verify).toContain('REJECTED: ${{ steps.check.outputs.rejected }}');
    expect(verify).toContain('if [ "$REJECTED" = "true" ]; then gh issue edit "$ISSUE" --add-label rejected; fi');
    expect(verify).not.toContain('--remove-label rejected');
  });

  it("caches the inbox's seen ids, filed index and read ranges in their own caches, restored before it runs and saved even if it fails (#1000, #999)", () => {
    const inboxSteps = steps(jobs(read('hall-of-fame-inbox.yml')).inbox);
    const at = inboxSteps.findIndex((s) => s.includes('scripts/hall-of-fame.ts inbox'));
    for (const [file, name] of [[SEEN_PATH, 'hof-inbox-seen'], [FILED_PATH, 'hof-inbox-filed'], [READ_PATH, 'hof-inbox-read']]) {
      const cache = (kind: string) => inboxSteps.findIndex((s) => s.includes(`actions/cache/${kind}@`) && s.includes(`path: ${file}\n`));
      expect(cache('restore'), file).toBeGreaterThanOrEqual(0);
      expect(cache('restore'), file).toBeLessThan(at);
      expect(inboxSteps[cache('restore')]).toContain(`key: ${name}-\${{ github.run_id }}`);
      expect(inboxSteps[cache('restore')]).toMatch(new RegExp(`^ +restore-keys: ${name}-$`, 'm'));
      expect(cache('save'), file).toBeGreaterThan(at);
      expect(inboxSteps[cache('save')]).toContain('if: always()');
      expect(inboxSteps[cache('save')]).toContain(`key: ${name}-\${{ github.run_id }}`);
    }
  });

  it('redeploys only when verify-issue asks to, not on every label repair (#650)', () => {
    const { verify, redeploy } = jobs(read('hall-of-fame.yml'));
    expect(verify.join('\n')).toContain('redeploy: ${{ steps.check.outputs.redeploy }}');
    const condition = redeploy.find((l) => l.trim().startsWith('if:'));
    expect(condition?.trim()).toBe("if: needs.verify.outputs.verified == 'true' && needs.verify.outputs.redeploy == 'true'");
  });

  describe('the issue workflow\'s "Comment and label" step, run in the shell it declares with a fake gh', () => {
    const { step, script } = stepScript(jobs(read('hall-of-fame.yml')).verify, 'gh issue comment');
    // Logs every call; like the real gh, refuses a comment with an empty body.
    const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "issue comment" ]; then
  file=""
  while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && file="$2"; shift; done
  [ -s "$file" ] || { echo "body cannot be blank" >&2; exit 1; }
fi
`;
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'hof-step-'));
      mkdirSync(path.join(dir, 'bin'));
      writeFileSync(path.join(dir, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
      writeFileSync(path.join(dir, 'step.sh'), script);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Runs the step as Actions does for its `shell:`; returns its `gh issue` and `gh api` calls. */
    const runStep = (comment: string, outputs: Record<string, string> = {}) => {
      writeFileSync(path.join(dir, 'hof-comment.md'), comment);
      const log = path.join(dir, 'gh.log');
      const env = { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, GH_LOG: log, GITHUB_REPOSITORY: 'owner/repo', ISSUE: '7', VERIFIED: 'true', LABEL: 'verified', REJECTED: 'false', DUPLICATE: '', ...outputs };
      const ran = spawnSync('bash', [...bashArgs(step), 'step.sh'], { cwd: dir, env, encoding: 'utf8' });
      expect(ran.status, ran.stderr).toBe(0);
      return readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('issue ') || l.startsWith('api '));
    };
    const LABELLED = ['issue edit 7 --add-label hall-of-fame,verified', 'issue edit 7 --remove-label not-verified', 'issue edit 7 --remove-label daily', 'issue close 7 --reason completed'];

    it('runs under pipefail (`shell: bash`), not the default `bash -e`', () => {
      expect(step).toMatch(/^ {8}shell: bash$/m);
    });

    it('repairs the labels of an already-commented pull without commenting again (#650)', () => {
      expect(runStep('')).toEqual(LABELLED);
    });

    it('comments, then labels, a new verification', () => {
      expect(runStep('**Verified!**')).toEqual(['issue comment 7 --body-file hof-comment.md', ...LABELLED]);
    });

    const REFUSED = ['issue comment 7 --body-file hof-comment.md', 'issue edit 7 --add-label hall-of-fame,not-verified', 'issue edit 7 --remove-label verified', 'issue edit 7 --remove-label daily'];

    it('leaves a refused pull open, so the submitter can fix the link', () => {
      expect(runStep('**Not added.**', { VERIFIED: 'false' })).toEqual(REFUSED);
    });

    it('closes a duplicate as a duplicate, after commenting and labelling, and touches no other issue (#21)', () => {
      expect(runStep('**Not added.** Duplicate of #3', { VERIFIED: 'false', DUPLICATE: '3' })).toEqual([
        ...REFUSED,
        'api --method PATCH repos/owner/repo/issues/7 -f state=closed -f state_reason=duplicate',
      ]);
    });
  });

  it('the issue workflow only runs on Hall of Fame issues', () => {
    expect(triggers(read('hall-of-fame.yml'))).toMatch(/issues:\s*\n\s*types: \[opened, edited, reopened\]/);
    expect(jobs(read('hall-of-fame.yml')).verify.join('\n')).toContain(
      "if: startsWith(github.event.issue.title, '[Hall of Fame]')",
    );
  });
});

describe('workflows a fork pull request can start (offline contracts)', () => {
  for (const file of ['ci.yml', 'browser-tests.yml']) {
    it(`${file} can read the code and nothing else`, () => {
      const text = read(file);
      expect(triggers(text)).toMatch(/^ {2}pull_request:/m);
      expect(triggers(text)).not.toMatch(/pull_request_target/);
      expect(topPermissions(text)).toEqual({ contents: 'read' });
      for (const [id, job] of Object.entries(jobs(text))) expect(jobPermissions(job), id).toBeNull();
      expect(text).not.toMatch(/secrets\./);
      expect(text).not.toMatch(/:\s*write\b/);
    });
  }

  it('deploy.yml, which holds the secrets, never runs for a pull request', () => {
    const text = read('deploy.yml');
    expect(triggers(text)).not.toMatch(/pull_request/);
    expect(topPermissions(text)).toBe('{}');
  });
});

describe('test-order.yml, the nightly shuffled and repeat unit-test run (#768)', () => {
  const text = read('test-order.yml');
  const all = jobs(text);
  const shuffled = all.shuffled.join('\n');
  const REPLAY = 'npx vitest run --testTimeout=15000 --sequence.shuffle --sequence.seed=';
  const CREATE = 'issue create --title Nightly test-order run failed --label test-order --body-file report.md';

  it('runs on a schedule or by hand, never for a pull request, and holds no secrets', () => {
    expect(triggers(text)).toMatch(/^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: '\d+ \d+ \* \* \*'/m);
    expect(triggers(text)).toMatch(/^ {2}workflow_dispatch:/m);
    expect(triggers(text)).not.toMatch(/pull_request/);
    expect(text).not.toMatch(/secrets\./);
    for (const run of runCommands(text)) expect(run).not.toContain('${{');
  });

  it('grants nothing by default; the tests only read the code and only the report writes issues', () => {
    expect(topPermissions(text)).toBe('{}');
    expect(Object.keys(all).sort()).toEqual(['report', 'shuffled']);
    expect(jobPermissions(all.shuffled)).toEqual({ contents: 'read' });
    expect(jobPermissions(all.report)).toEqual({ issues: 'write' });
    expect(all.report.join('\n')).not.toMatch(/actions\/checkout/);
  });

  it('runs the suite twice in the same recorded order, never retries, and logs the seed', () => {
    const runs = runCommands(shuffled).map((r) => r.trim()).filter((r) => r.startsWith('run: npx vitest'));
    expect(runs).toEqual([`run: ${REPLAY}"$SEED"`, `run: ${REPLAY}"$SEED"`]);
    const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/retry|retries|continue-on-error/);
    expect(shuffled).toContain('echo "seed=$seed" >> "$GITHUB_OUTPUT"');
    expect(shuffled).toContain('echo "Shuffle seed: $seed (revision $GITHUB_SHA)"');
    expect(shuffled).toContain(`${REPLAY}$SEED`);
    expect(shuffled).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  it('reports a test job that failed, timed out or was cancelled, but not one that passed or never ran', () => {
    // GitHub cancels a job that runs past timeout-minutes, and failure() is true only for a failed
    // ancestor, so `failure()` alone would let a timed-out night go unreported.
    expect(all.shuffled.join('\n')).toMatch(/^ {4}timeout-minutes: \d+$/m);
    const condition = all.report.find((l) => l.trim().startsWith('if:'));
    expect(condition?.trim()).toBe("if: ${{ always() && needs.shuffled.result != 'success' && needs.shuffled.result != 'skipped' }}");
    expect(all.report.join('\n')).toContain('RESULT: ${{ needs.shuffled.result }}');
  });

  describe('the seed step, run in the shell it declares', () => {
    const { step, script } = stepScript(all.shuffled, 'GITHUB_OUTPUT');
    const runSeed = (seed: string) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'test-order-seed-'));
      try {
        writeFileSync(path.join(dir, 'step.sh'), script);
        const out = path.join(dir, 'output');
        writeFileSync(out, '');
        const env = { PATH: process.env.PATH, INPUT_SEED: seed, GITHUB_RUN_ID: '98765432101', GITHUB_SHA: 'abc123', GITHUB_OUTPUT: out };
        const ran = spawnSync('bash', [...bashArgs(step), 'step.sh'], { cwd: dir, env, encoding: 'utf8' });
        return { status: ran.status, output: readFileSync(out, 'utf8') };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('records a dispatched seed of 1-9 digits, or one from the run id', () => {
      expect(runSeed('42')).toEqual({ status: 0, output: 'seed=42\n' });
      expect(runSeed('123456789')).toEqual({ status: 0, output: 'seed=123456789\n' });
      expect(runSeed('')).toEqual({ status: 0, output: 'seed=765432101\n' });
    });

    it.each(['abc', '12a', '-1', '4 2', '1234567890', '$(id)'])('fails on the dispatched seed %j and records none', (seed) => {
      expect(runSeed(seed)).toEqual({ status: 1, output: '' });
    });
  });

  describe('the report step, run in the shell it declares with a fake gh', () => {
    const { step, script } = stepScript(all.report, 'gh issue create');
    // Logs every call; `issue list` prints $FAKE_ISSUES, as `gh issue list --json number,author` does,
    // or fails as an API error would when $FAKE_LIST_FAILS is set.
    const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "issue list" ]; then
  [ -z "$FAKE_LIST_FAILS" ] || { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
  printf '%s' "$FAKE_ISSUES"
fi
`;
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'test-order-step-'));
      mkdirSync(path.join(dir, 'bin'));
      writeFileSync(path.join(dir, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
      writeFileSync(path.join(dir, 'step.sh'), script);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Runs the step as Actions does for its `shell:`; returns its exit status and `gh issue` calls other than the lookup. */
    const execStep = (issues: { number: number; login: string }[], seed = '424242', extra: Record<string, string> = {}) => {
      const log = path.join(dir, 'gh.log');
      const env = {
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, GH_LOG: log, GITHUB_SHA: 'abc123', SEED: seed,
        FIRST: 'success', REPEAT: 'failure', RESULT: 'failure', RUN_URL: 'https://github.com/o/r/actions/runs/1',
        FAKE_ISSUES: JSON.stringify(issues.map(({ number, login }) => ({ number, author: { login } }))),
        ...extra,
      };
      const ran = spawnSync('bash', [...bashArgs(step), 'step.sh'], { cwd: dir, env, encoding: 'utf8' });
      const calls = readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('issue ') && !l.startsWith('issue list'));
      return { ran, calls };
    };
    /** Runs the step, which must succeed; returns its calls and the report it wrote. */
    const runStep = (issues: { number: number; login: string }[], seed = '424242', extra: Record<string, string> = {}) => {
      const { ran, calls } = execStep(issues, seed, extra);
      expect(ran.status, ran.stderr).toBe(0);
      return { calls, report: readFileSync(path.join(dir, 'report.md'), 'utf8') };
    };

    it('runs under pipefail (`shell: bash`), not the default `bash -e`', () => {
      expect(step).toMatch(/^ {8}shell: bash$/m);
    });

    it('fails, opening and commenting on nothing, when the issue lookup fails', () => {
      const { ran, calls } = execStep([{ number: 12, login: 'github-actions[bot]' }], '424242', { FAKE_LIST_FAILS: '1' });
      expect(ran.status).not.toBe(0);
      expect(calls).toEqual([]);
    });

    it('says the test job was cancelled, as a timeout leaves it', () => {
      const { report } = runStep([], '424242', { FIRST: 'cancelled', REPEAT: '', RESULT: 'cancelled' });
      expect(report).toContain('Test job: cancelled (cancelled includes hitting its timeout)');
      expect(report).toContain('Shuffled run: cancelled; repeat run, same seed: not run');
    });

    it('opens the issue when it has none open, with the seed, revision and replay command', () => {
      const { calls, report } = runStep([]);
      expect(calls).toEqual([CREATE]);
      expect(report).toContain('Test job: failure');
      expect(report).toContain('Seed: 424242');
      expect(report).toContain('Revision: `abc123`');
      expect(report).toContain('Shuffled run: success; repeat run, same seed: failure');
      expect(report).toContain(`Replay: \`git checkout abc123 && npm ci && ${REPLAY}424242\``);
    });

    it('comments on its own oldest open issue instead of opening another', () => {
      const { calls } = runStep([{ number: 30, login: 'app/github-actions' }, { number: 12, login: 'github-actions[bot]' }]);
      expect(calls).toEqual(['issue comment 12 --body-file report.md']);
    });

    it('ignores a labelled issue someone else opened', () => {
      const { calls } = runStep([{ number: 5, login: 'someone' }, { number: 6, login: 'github-actions-fan' }]);
      expect(calls).toEqual([CREATE]);
    });

    it('says when the run failed before a seed was picked', () => {
      const { report } = runStep([], '');
      expect(report).toContain('Seed: none (failed before the tests ran)');
      expect(report).not.toContain('Replay:');
    });
  });
});

describe('ops-health.yml, the operational health report (#715)', () => {
  const text = read('ops-health.yml');
  const all = jobs(text);

  it('runs on a schedule, after a deploy of main or by hand, never for a pull request, and holds no secrets', () => {
    const on = triggers(text);
    expect(on).toMatch(/^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: '\d+ [\d*/]+ \* \* \*'/m);
    expect(on).toMatch(/^ {2}workflow_run:\n {4}workflows:\n {6}- Deploy to GitHub Pages\n {4}types: \[completed\]\n {4}branches: \[main\]$/m);
    expect(read('deploy.yml')).toMatch(/^name: Deploy to GitHub Pages$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on).not.toMatch(/pull_request/);
    expect(text).not.toMatch(/secrets\./);
    for (const run of runCommands(text)) expect(run).not.toContain('${{');
    expect(text).toMatch(/^concurrency:\n {2}group: ops-health\n {2}cancel-in-progress: false$/m);
  });

  it('grants nothing by default; collecting only reads runs and code, and only the report writes issues', () => {
    expect(topPermissions(text)).toBe('{}');
    expect(Object.keys(all).sort()).toEqual(['collect', 'report']);
    expect(jobPermissions(all.collect)).toEqual({ actions: 'read', contents: 'read' });
    expect(jobPermissions(all.report)).toEqual({ issues: 'write' });
    expect(all.report.join('\n')).not.toMatch(/actions\/checkout|npm |npx /);
    expect(all.collect.join('\n')).toContain('persist-credentials: false');
  });

  it("runs main's own script, and reports only from a collection that finished", () => {
    expect(all.collect.find((l) => l.trim().startsWith('if:'))?.trim()).toBe("if: ${{ github.ref == 'refs/heads/main' }}");
    expect(all.report.find((l) => l.trim().startsWith('if:'))?.trim()).toBe("if: ${{ needs.collect.result == 'success' }}");
    for (const job of Object.values(all)) expect(job.join('\n')).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });

  it('pins every action to the same commit ci.yml or deploy.yml uses', () => {
    const pinned = new Set(
      [read('ci.yml'), read('deploy.yml')].flatMap((t) => [...t.matchAll(/uses: (\S+@[0-9a-f]{40}) # \S+/g)].map((m) => m[0])),
    );
    const uses = [read('ops-health.yml'), read('hall-of-fame-inbox.yml')].flatMap((t) => [...t.matchAll(/uses: \S+.*/g)].map((m) => m[0]));
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses.filter((u) => /actions\/(checkout|setup-node|upload-artifact)@/.test(u))) expect(pinned).toContain(use);
  });

  it('titles a relay probe as ops-health expects, so it is never counted as an inbox run', () => {
    expect(read('hall-of-fame-inbox.yml')).toMatch(new RegExp(`^run-name: \\$\\{\\{ inputs\\.probe && '${INBOX_PROBE_TITLE}' \\|\\| 'Hall of Fame inbox' \\}\\}$`, 'm'));
  });

  it("has each inbox run upload its counts-only summary, even when the inbox step failed, and never fail on it", () => {
    const inbox = steps(jobs(read('hall-of-fame-inbox.yml')).inbox);
    const at = inbox.findIndex((s) => s.includes('name: hof-inbox-summary'));
    expect(at).toBeGreaterThan(inbox.findIndex((s) => s.includes('scripts/hall-of-fame.ts inbox')));
    expect(inbox[at]).toContain('if: ${{ !cancelled() }}');
    expect(inbox[at]).toMatch(/^ {8}continue-on-error: true$/m);
    expect(inbox[at]).toMatch(/^ {10}path: hof-inbox-summary\.json$/m);
    expect(inbox[at]).toMatch(/^ {10}retention-days: 3$/m);
  });

  describe('the report step, run in the shell it declares with a fake gh', () => {
    const { step, script } = stepScript(all.report, 'gh issue create');
    // Logs every call on one line; `issue list` prints $FAKE_ISSUES, as `gh issue list --json
    // number,title,state,author` does, or fails as an API error would when $FAKE_LIST_FAILS is set.
    const FAKE_GH = `#!/bin/sh
printf '%s' "$*" | tr '\\n' '|' >> "$GH_LOG"; echo >> "$GH_LOG"
if [ "$1 $2" = "issue list" ]; then
  [ -z "$FAKE_LIST_FAILS" ] || { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
  printf '%s' "$FAKE_ISSUES"
fi
`;
    const RUN_URL = 'https://github.com/o/r/actions/runs/7';
    type Issue = { number: number; key: ConditionKey; state: 'OPEN' | 'CLOSED'; login: string };
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'ops-health-step-'));
      mkdirSync(path.join(dir, 'bin'));
      writeFileSync(path.join(dir, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
      writeFileSync(path.join(dir, 'step.sh'), script);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Runs the step as Actions does; returns its exit status and every `gh` call but the label and the lookup. */
    const execStep = (states: Partial<Record<ConditionKey, string>>, issues: Issue[], extra: Record<string, string> = {}) => {
      const log = path.join(dir, 'gh.log');
      const conditions = Object.entries(states).map(([key, state]) => ({
        key, title: CONDITIONS[key as ConditionKey], state, reason: `${key} is ${state}`,
      }));
      const env = {
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, GH_LOG: log, RUN_URL,
        RUNBOOK: 'https://github.com/o/r/blob/main/docs/DEVELOPMENT.md#operational-health',
        CONDITIONS: JSON.stringify(conditions),
        FAKE_ISSUES: JSON.stringify(issues.map(({ number, key, state, login }) => ({ number, title: CONDITIONS[key], state, author: { login } }))),
        ...extra,
      };
      const ran = spawnSync('bash', [...bashArgs(step), 'step.sh'], { cwd: dir, env, encoding: 'utf8' });
      const calls = readFileSync(log, 'utf8').trim().split('\n').filter((l) => !/^(label create|issue list) /.test(l));
      return { ran, calls };
    };
    const runStep = (states: Partial<Record<ConditionKey, string>>, issues: Issue[] = []) => {
      const { ran, calls } = execStep(states, issues);
      expect(ran.status, ran.stderr).toBe(0);
      return calls;
    };
    const create = (key: ConditionKey) => `issue create --title ${CONDITIONS[key]} --label ops-health --body-file body.md`;

    it('runs under pipefail (`shell: bash`), not the default `bash -e`', () => {
      expect(step).toMatch(/^ {8}shell: bash$/m);
    });

    it('fails, opening and closing nothing, when the issue lookup fails', () => {
      const { ran, calls } = execStep({ 'deploy-failing': 'unhealthy', 'inbox-stale': 'ok' }, [], { FAKE_LIST_FAILS: '1' });
      expect(ran.status).not.toBe(0);
      expect(calls).toEqual([]);
    });

    it('opens one issue for each condition that turned unhealthy, with the run and runbook', () => {
      const calls = runStep({ 'deploy-failing': 'unhealthy', 'deploy-behind': 'ok', 'inbox-stale': 'unhealthy' });
      expect(calls).toEqual([create('deploy-failing'), create('inbox-stale')]);
      const body = readFileSync(path.join(dir, 'body.md'), 'utf8');
      expect(body).toContain('inbox-stale is unhealthy');
      expect(body).toContain(`Seen by: ${RUN_URL}`);
      expect(body).toContain('Runbook: https://github.com/o/r/blob/main/docs/DEVELOPMENT.md#operational-health');
    });

    it('does nothing while a condition stays unhealthy and its issue is open', () => {
      expect(runStep({ 'deploy-failing': 'unhealthy' }, [{ number: 4, key: 'deploy-failing', state: 'OPEN', login: 'app/github-actions' }])).toEqual([]);
    });

    it('reopens its newest closed issue when a condition comes back', () => {
      const calls = runStep({ 'inbox-failing': 'unhealthy' }, [
        { number: 3, key: 'inbox-failing', state: 'CLOSED', login: 'github-actions[bot]' },
        { number: 9, key: 'inbox-failing', state: 'CLOSED', login: 'github-actions' },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^issue reopen 9 --comment inbox-failing is unhealthy\|/);
    });

    it('closes the open issue once its condition is ok, and only that one', () => {
      const calls = runStep({ 'inbox-deferring': 'ok', 'deploy-behind': 'ok' }, [
        { number: 8, key: 'inbox-deferring', state: 'OPEN', login: 'evanlin23' },
        { number: 2, key: 'deploy-behind', state: 'CLOSED', login: 'github-actions[bot]' },
      ]);
      expect(calls).toEqual([`issue close 8 --reason completed --comment Cleared: inbox-deferring is ok (${RUN_URL})`]);
    });

    it('neither opens nor closes anything for a condition it could not judge', () => {
      expect(runStep({ 'deploy-failing': 'unknown' }, [])).toEqual([]);
      expect(runStep({ 'deploy-failing': 'unknown' }, [{ number: 4, key: 'deploy-failing', state: 'OPEN', login: 'github-actions[bot]' }])).toEqual([]);
    });

    it('ignores a labelled issue with the same title that someone else opened', () => {
      const calls = runStep({ 'deploy-failing': 'unhealthy', 'inbox-stale': 'ok' }, [
        { number: 5, key: 'deploy-failing', state: 'OPEN', login: 'someone' },
        { number: 6, key: 'inbox-stale', state: 'OPEN', login: 'github-actions-fan' },
      ]);
      expect(calls).toEqual([create('deploy-failing')]);
    });
  });
});

describe('browser-tests.yml Playwright jobs (#658)', () => {
  const lines = read('browser-tests.yml').split('\n');
  const all = jobs(read('browser-tests.yml'));
  const playwright = (JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
    packages: Record<string, { version: string }>;
  }).packages['node_modules/@playwright/test'].version;
  // The jobs that run Playwright. Names are required checks, so they are pinned here as well.
  const names = {
    'browser-shard': 'browser-tests shard ${{ matrix.shard }}/3',
    'browser-burn-in': 'browser-burn-in shard ${{ matrix.shard }}/3',
    'cross-browser-smoke': 'cross-browser-smoke',
  };
  const runners = Object.entries(all).filter(([, job]) => /npx playwright|npm run test:browser/.test(job.join('\n')));

  it('finds exactly the jobs that run Playwright', () => {
    expect(runners.map(([id]) => id).sort()).toEqual(Object.keys(names).sort());
  });

  it.each(Object.entries(names))('%s keeps its name', (id, name) => {
    expect(all[id].join('\n')).toMatch(new RegExp(`^ {4}name: ${name.replace(/[$.{}/]/g, '\\$&')}$`, 'm'));
  });

  it.each(Object.keys(names))(
    '%s runs in the Playwright image whose tag is the installed @playwright/test, pinned by digest',
    (id) => {
      expect(/^ {6}image: (\S+)$/m.exec(all[id].join('\n'))?.[1]).toMatch(
        new RegExp(`^mcr\\.microsoft\\.com/playwright:v${playwright.replaceAll('.', '\\.')}-[a-z]+@sha256:[0-9a-f]{64}$`),
      );
    },
  );

  it('uses one image in every job', () => {
    const images = new Set(lines.flatMap((l) => /^ {6}image: (\S+)$/.exec(l)?.[1] ?? []));
    expect([...images]).toHaveLength(1);
  });

  it.each(Object.keys(names))('%s runs as the runner user and installs no browsers or system packages', (id) => {
    const job = all[id].join('\n');
    expect(job).toMatch(/^ {6}options: --user 1001$/m);
    expect(job.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toMatch(/playwright install|apt-get|apt |--with-deps/);
  });
});
