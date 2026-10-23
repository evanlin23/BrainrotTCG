// ci.yml runs `npm run check` as parallel stage jobs behind one gate, the `check` job branch
// protection requires (#767). These hold the stages to the script and the gate to every stage.
// Read as text, like scripts/hof-workflows.test.ts: two-space job ids, one-line `run:` and `needs:`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };

/** Each job's lines, keyed by its id. */
const jobs = (() => {
  const lines = ci.slice(ci.indexOf('\njobs:\n') + 1).split('\n').slice(1);
  const out: Record<string, string[]> = {};
  let id: string | null = null;
  for (const line of lines) {
    const next = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (next) out[(id = next)] = [];
    else if (id && /^ {4}/.test(line)) out[id].push(line);
  }
  return out;
})();

const runs = (job: string[]) => job.flatMap((l) => /^\s+(?:- )?run: (.+)$/.exec(l)?.[1] ?? []);
const key = (job: string[], name: string) => job.find((l) => l.startsWith(`    ${name}:`))?.slice(`    ${name}:`.length).trim();

const gate = jobs.check;
const stages = (key(gate, 'needs') ?? '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim());
// The other required checks: they stand on their own and the gate leaves them alone.
const STANDALONE = ['independent-verifier', 'workflow-validation'];

describe('the CI stages behind the required check (#767)', () => {
  it('run every part of npm run check, each exactly once, and nothing runs the whole chain', () => {
    const parts = pkg.scripts.check.split(' && ');
    expect(parts.length).toBeGreaterThan(1);
    const run = stages.flatMap((id) => runs(jobs[id]));
    for (const part of parts) expect(run.filter((r) => r === part), part).toHaveLength(1);
    expect(Object.values(jobs).flatMap(runs)).not.toContain('npm run check');
  });

  it('gates every job except the required checks that stand on their own', () => {
    expect(stages.length).toBeGreaterThan(1);
    expect(new Set([...stages, 'check', ...STANDALONE])).toEqual(new Set(Object.keys(jobs)));
    for (const id of [...stages, ...STANDALONE]) expect(key(jobs[id], 'if'), id).toBeUndefined();
  });

  it('runs the gate even after a failed or cancelled stage, and passes only when every stage succeeded', () => {
    expect(key(gate, 'if')).toBe('always()');
    expect(key(gate, 'name')).toBeUndefined();
    const script = gate.join('\n');
    for (const id of stages) {
      const env = new RegExp(`^ {10}(\\w+): \\$\\{\\{ needs\\.${id}\\.result \\}\\}$`, 'm').exec(script)?.[1];
      expect(env, id).toBeDefined();
      expect(gate).toContain(`          test "$${env}" = success`);
    }
    expect(script).not.toMatch(/skipped|\|\||continue-on-error/);
  });

  it('never lets a step fail quietly', () => {
    expect(ci).not.toMatch(/continue-on-error|\|\| true/);
  });
});
