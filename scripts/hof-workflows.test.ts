// Offline contracts for the workflows that touch the Hall of Fame and the ones a fork pull request
// can start. Read as text (there's no YAML parser here), so this only covers the shape these files
// already have: two-space indents, block-style `permissions`, one job per `  name:` line.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
