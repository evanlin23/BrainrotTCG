import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { browserCommand, stepBudget } from './browser';
import { agentEnvironment, clean, isBasePath, parseOptions, parseOutcome, uncommittedBuildInputs } from './contracts';

describe('local audit evidence contracts', () => {
  it('supports root and prefixed hosting while refusing URL/path escapes', () => {
    expect(isBasePath('/')).toBe(true);
    expect(isBasePath('/BrainrotTCG/')).toBe(true);
    for (const value of ['//', '/../../', 'https://example.com/', '/no-trailing-slash']) expect(isBasePath(value)).toBe(false);
  });
  it('bounds sequential tasks/time and rejects unknown and duplicate requests', () => {
    expect(parseOptions([])).toEqual({ selected: ['opening'], seconds: 90 });
    expect(parseOptions(['--task=opening', '--task=results', '--seconds=180']).selected).toHaveLength(2);
    for (const args of [['--task=constructor'], ['--task=opening', '--task=opening'], ['--seconds=999'], ['--parallel=20']]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });
  it('does not accept an agent success with no browser evidence', () => {
    const raw = JSON.stringify({ outcome: 'completed', observations: 'Done' });
    expect(() => parseOutcome(raw, [])).toThrow('No browser evidence');
    expect(parseOutcome(raw, ['snapshot: visible accessibility tree', 'click: visible control']).outcome).toBe('completed');
    expect(() => parseOutcome('{', [])).toThrow();
    expect(() => parseOutcome(JSON.stringify({ outcome: 'success' }), [])).toThrow();
  });
  it('bounds and removes URLs, opaque keys, emails and controls from retained prose', () => {
    const text = clean('https://example.com/?secret=oops hi@example.com ' + '01'.repeat(32) + '\n' + 'a'.repeat(2000));
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).not.toContain('secret=oops');
    expect(text).not.toContain('hi@example');
    expect(text).not.toContain('010101');
    expect(text).not.toContain('\n');
  });
});

describe('local audit runner boundary', () => {
  it('gives the agent CLI an allowlisted environment without CI or GitHub secrets', () => {
    const env = agentEnvironment({
      PATH: '/usr/bin', HOME: '/home/audit', OPENAI_API_KEY: 'agent-key', CODEX_API_KEY: 'codex-key', HTTPS_PROXY: 'http://proxy.invalid',
      GITHUB_TOKEN: 'secret', GH_TOKEN: 'secret', ACTIONS_RUNTIME_TOKEN: 'secret', NPM_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret',
      ANTHROPIC_API_KEY: 'secret', CI: 'true', BASE_PATH: '/BrainrotTCG/', TERM: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/audit', OPENAI_API_KEY: 'agent-key', CODEX_API_KEY: 'codex-key', HTTPS_PROXY: 'http://proxy.invalid' });
  });

  it('refuses tracked edits and untracked build inputs such as a draft set, but not ignored or unrelated files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'brainrot-audit-tree-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.name=Audit fixture', '-c', 'user.email=audit@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' });
      if (result.status !== 0) throw Error(result.stderr);
    };
    const write = (path: string, text = 'fixture') => {
      mkdirSync(join(directory, path, '..'), { recursive: true });
      writeFileSync(join(directory, path), text);
    };
    try {
      git('init', '-q');
      write('src/content/sets/genesis/set.json', '{}');
      write('.gitignore', 'src/generated/\n');
      git('add', '.');
      git('commit', '-qm', 'fixture');
      expect(uncommittedBuildInputs(directory)).toBe('');
      write('notes.txt');
      write('src/generated/cache.json');
      expect(uncommittedBuildInputs(directory)).toBe('');
      write('src/content/sets/draft-set/cards/card.webp');
      expect(uncommittedBuildInputs(directory)).toMatch(/untracked files/);
      rmSync(join(directory, 'src/content/sets/draft-set'), { recursive: true });
      write('public/draft.png');
      expect(uncommittedBuildInputs(directory)).toMatch(/untracked files/);
      rmSync(join(directory, 'public'), { recursive: true });
      write('src/content/sets/genesis/set.json', '{"draft":true}');
      expect(uncommittedBuildInputs(directory)).toMatch(/tracked changes/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('restricted browser adapter', () => {
  // Every page call yields first, as Playwright does, so concurrent commands interleave.
  function fakePage(matches = 1) {
    const clicked: string[] = [];
    const pressed: string[] = [];
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    const page = {
      getByRole: (_role: string, { name }: { name: string }) => ({
        count: async () => { await tick(); return matches; },
        click: async () => { await tick(); clicked.push(name); },
      }),
      locator: () => ({ count: async () => { await tick(); return 0; }, ariaSnapshot: async () => { await tick(); return '- main'; } }),
      keyboard: { press: async (key: string) => { await tick(); pressed.push(key); } },
      waitForTimeout: tick,
    };
    return { page: page as unknown as Page, clicked, pressed };
  }

  it('keeps the step budget strict under concurrent calls', async () => {
    const { page, pressed } = fakePage();
    const steps: string[] = [];
    const commands = Array.from({ length: stepBudget + 20 }, (_, index) => index % 3
      ? { name: 'press', arguments: { key: index % 2 ? 'Tab' : 'Enter' } }
      : { name: 'click', arguments: { role: 'button', name: 'Open pack' } });
    const results = await Promise.allSettled(commands.map((command) => browserCommand(page, command, steps)));
    expect(steps).toHaveLength(stepBudget);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(stepBudget);
    expect(results.filter((result) => result.status === 'rejected').every((result) => /budget/.test(String(result.reason)))).toBe(true);
    expect(pressed.length).toBeLessThanOrEqual(stepBudget);
    const nearlySpent = Array<string>(stepBudget - 1).fill('snapshot: visible accessibility tree');
    await Promise.allSettled([1, 2, 3].map(() => browserCommand(page, { name: 'press', arguments: { key: 'Tab' } }, nearlySpent)));
    expect(nearlySpent).toHaveLength(stepBudget);
  });

  it('clicks only one control with a non-empty exact accessible name', async () => {
    for (const name of ['', '   ', '\t\n']) {
      const { page, clicked } = fakePage();
      const steps: string[] = [];
      await expect(browserCommand(page, { name: 'click', arguments: { role: 'button', name } }, steps)).rejects.toThrow('non-empty');
      expect(steps).toEqual([]);
      expect(clicked).toEqual([]);
    }
    for (const [matches, message] of [[0, 'No visible button'], [3, '3 visible buttons share']] as const) {
      const { page, clicked } = fakePage(matches);
      const steps: string[] = ['snapshot: visible accessibility tree'];
      await expect(browserCommand(page, { name: 'click', arguments: { role: 'button', name: 'Open pack' } }, steps)).rejects.toThrow(message);
      expect(clicked).toEqual([]);
      expect(steps).toEqual(['snapshot: visible accessibility tree', 'not completed: click: Open pack']);
      // A click that never happened is not evidence of a completed task.
      expect(() => parseOutcome(JSON.stringify({ outcome: 'completed', observations: 'Done' }), steps)).toThrow('No browser evidence');
    }
    const { page, clicked } = fakePage(1);
    const steps: string[] = [];
    await expect(browserCommand(page, { name: 'click', arguments: { role: 'button', name: 'Open pack' } }, steps)).resolves.toBe('- main');
    expect(clicked).toEqual(['Open pack']);
    expect(steps).toEqual(['click: Open pack']);
  });
});
