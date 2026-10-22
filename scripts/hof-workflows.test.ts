// Offline contracts for the workflows that touch the Hall of Fame, the ones a fork pull request can
// start, and the nightly test-order run. Read as text (there's no YAML parser here), so this only covers the shape these files
// already have: two-space indents, block-style `permissions`, one job per `  name:` line. Two steps'
// shells also run here, against a fake `gh`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('labels a pull refused for its display name `rejected`, and never takes that label off', () => {
    const verify = jobs(read('hall-of-fame.yml')).verify.join('\n');
    expect(verify).toContain('REJECTED: ${{ steps.check.outputs.rejected }}');
    expect(verify).toContain('if [ "$REJECTED" = "true" ]; then gh issue edit "$ISSUE" --add-label rejected; fi');
    expect(verify).not.toContain('--remove-label rejected');
  });

  it('redeploys only when verify-issue asks to, not on every label repair (#650)', () => {
    const { verify, redeploy } = jobs(read('hall-of-fame.yml'));
    expect(verify.join('\n')).toContain('redeploy: ${{ steps.check.outputs.redeploy }}');
    const condition = redeploy.find((l) => l.trim().startsWith('if:'));
    expect(condition?.trim()).toBe("if: needs.verify.outputs.verified == 'true' && needs.verify.outputs.redeploy == 'true'");
  });

  describe('the issue workflow\'s "Comment and label" step, run under bash -e with a fake gh', () => {
    /** The step's shell, dedented, as the runner writes it to a script file. */
    const script = () => {
      const run = runCommands(jobs(read('hall-of-fame.yml')).verify.join('\n')).find((r) => r.includes('gh issue comment'));
      expect(run, 'Comment and label step').toBeDefined();
      const lines = run!.split('\n').slice(1);
      const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)));
      return lines.map((l) => l.slice(indent)).join('\n');
    };
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
      writeFileSync(path.join(dir, 'step.sh'), script());
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Runs the step as Actions does (`bash --noprofile --norc -eo pipefail`); returns its `gh issue` calls. */
    const runStep = (comment: string) => {
      writeFileSync(path.join(dir, 'hof-comment.md'), comment);
      const log = path.join(dir, 'gh.log');
      const env = { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, GH_LOG: log, ISSUE: '7', VERIFIED: 'true', LABEL: 'verified', REJECTED: 'false' };
      const ran = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', 'step.sh'], { cwd: dir, env, encoding: 'utf8' });
      expect(ran.status, ran.stderr).toBe(0);
      return readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('issue '));
    };
    const LABELLED = ['issue edit 7 --add-label hall-of-fame,verified', 'issue edit 7 --remove-label not-verified', 'issue edit 7 --remove-label daily', 'issue close 7 --reason completed'];

    it('repairs the labels of an already-commented pull without commenting again (#650)', () => {
      expect(runStep('')).toEqual(LABELLED);
    });

    it('comments, then labels, a new verification', () => {
      expect(runStep('**Verified!**')).toEqual(['issue comment 7 --body-file hof-comment.md', ...LABELLED]);
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

  it('reports only a failed test job', () => {
    const condition = all.report.find((l) => l.trim().startsWith('if:'));
    expect(condition?.trim()).toBe("if: ${{ failure() && needs.shuffled.result == 'failure' }}");
  });

  describe('the report step, run under bash -e with a fake gh', () => {
    /** The step's shell, dedented, as the runner writes it to a script file. */
    const script = () => {
      const run = runCommands(all.report.join('\n')).find((r) => r.includes('gh issue create'));
      expect(run, 'report step').toBeDefined();
      const lines = run!.split('\n').slice(1);
      const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)));
      return lines.map((l) => l.slice(indent)).join('\n');
    };
    // Logs every call; `issue list` prints $FAKE_ISSUES, as `gh issue list --json number,author` does.
    const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "issue list" ]; then printf '%s' "$FAKE_ISSUES"; fi
`;
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'test-order-step-'));
      mkdirSync(path.join(dir, 'bin'));
      writeFileSync(path.join(dir, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
      writeFileSync(path.join(dir, 'step.sh'), script());
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Runs the step; returns its `gh issue` calls other than the lookup, and the report it wrote. */
    const runStep = (issues: { number: number; login: string }[], seed = '424242') => {
      const log = path.join(dir, 'gh.log');
      const env = {
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, GH_LOG: log, GITHUB_SHA: 'abc123', SEED: seed,
        FIRST: 'success', REPEAT: 'failure', RUN_URL: 'https://github.com/o/r/actions/runs/1',
        FAKE_ISSUES: JSON.stringify(issues.map(({ number, login }) => ({ number, author: { login } }))),
      };
      const ran = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', 'step.sh'], { cwd: dir, env, encoding: 'utf8' });
      expect(ran.status, ran.stderr).toBe(0);
      const calls = readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('issue ') && !l.startsWith('issue list'));
      return { calls, report: readFileSync(path.join(dir, 'report.md'), 'utf8') };
    };

    it('opens the issue when it has none open, with the seed, revision and replay command', () => {
      const { calls, report } = runStep([]);
      expect(calls).toEqual([CREATE]);
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
