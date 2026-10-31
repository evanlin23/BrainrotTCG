import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { bridgeHandler, browserCommand, stepBudget } from './browser';
import { agentEnvironment, clean, instructionFiles, isBasePath, parseOptions, parseOutcome, redactAcrossFields, redactReportTasks, uncommittedBuildInputs } from './contracts';

describe('local audit evidence contracts', () => {
  it('supports root and prefixed hosting while refusing URL/path escapes', () => {
    expect(isBasePath('/')).toBe(true);
    expect(isBasePath('/BrainrotTCG/')).toBe(true);
    for (const value of ['//', '/../../', 'https://example.com/', '/no-trailing-slash']) expect(isBasePath(value)).toBe(false);
  });
  it('bounds sequential tasks, time and turns and rejects unknown and duplicate requests', () => {
    expect(parseOptions([])).toEqual({ selected: ['opening'], seconds: 90, turns: 15 });
    expect(parseOptions(['--task=opening', '--task=results', '--seconds=180', '--turns=8'])).toEqual({ selected: ['opening', 'results'], seconds: 180, turns: 8 });
    for (const args of [['--task=constructor'], ['--task=opening', '--task=opening'], ['--seconds=999'], ['--turns=1'], ['--turns=99'], ['--turns=x'], ['--parallel=20']]) {
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

describe('email redaction in retained prose', () => {
  it.each([
    'name at example dot com',
    'Name AT Example DOT Edu',
    'name [at] example [dot] com',
    'name (at) example (dot) org',
    'name {at} example {dot} net',
    'name [ at ] example [ dot ] co [dot] uk',
    'name[at]example[dot]com',
    'name(at)example(dot)com',
    'name{at}example{dot}org',
    'name@example[dot]com',
    'first[dot]last[at]example[dot]com',
    'name <at> example <dot> com',
    'Pull 1 @ pack.com',
    'name @ example.com',
    'name@ example.com',
    'name\nat example\ndot\ncom',
    'name at\n\nexample dot com',
    'first dot last at example dot com',
    'first [dot] last [at] example [dot] com',
    'name＠example．com',
    'na\u200bme@exa\u200bmple.com',
  ])('removes %j', (written) => {
    const text = clean(`My address is ${written}, thanks.`);
    expect(text).toBe(written.startsWith('Pull') ? 'My address is Pull [email], thanks.' : 'My address is [email], thanks.');
    expect(clean(`Write ${written}.`)).toBe(written.startsWith('Pull') ? 'Write Pull [email].' : 'Write [email].');
  });
  it('keeps ordinary prose that uses at, dot or a bare domain', () => {
    for (const prose of [
      'Meet at the dot in the corner, then look at the dot com bubble.',
      'The card looks great at a small size. The red dot is a nice touch.',
      'I stopped at the pack screen and the dot on the progress bar moved at once.',
      'I arrived at home dot com was not mentioned.',
      'Visit us at example.com for more, or look at it later.',
      'Shown at 10.30 [at] the top (dot) of the page',
      'Tap the dot at the end. Com Dot Com.',
    ]) expect(clean(prose)).toBe(prose);
  });
  it('still redacts an address after prose that uses at and dot', () => {
    expect(clean('Meet at the dot com bubble, email name at example dot com now')).toBe('Meet at the dot com bubble, email [email] now');
  });
  it('removes an address split across adjacent fields and keeps the field count', () => {
    expect(redactAcrossFields(['Contact name at', 'example dot', 'com for help', 'unrelated'])).toEqual(['Contact [email]', '', 'for help', 'unrelated']);
    expect(redactAcrossFields(['Plain field', 'at the dot'])).toEqual(['Plain field', 'at the dot']);
    expect(() => redactAcrossFields(['a\nb'])).toThrow();
  });
  it('sweeps click labels, observations and reasons of a report', () => {
    const tasks: Record<string, unknown>[] = [
      { task: 'opening', steps: ['snapshot: visible accessibility tree', 'not completed: click: Open pack', 'click: name at', 'press: Enter'], observations: 'example dot com showed up', reason: 'Task incomplete' },
      { task: 'sharing', outcome: 'unrun', reason: 'Not started' },
    ];
    redactReportTasks([...tasks, null, 'x']);
    expect(tasks[0]).toEqual({ task: 'opening', steps: ['snapshot: visible accessibility tree', 'not completed: click: Open pack', 'click: [email]', 'press: Enter'], observations: 'showed up', reason: 'Task incomplete' });
    expect(tasks[1]).toEqual({ task: 'sharing', outcome: 'unrun', reason: 'Not started' });
  });
  it('removes written-out forms from a parsed agent report', () => {
    const raw = JSON.stringify({ outcome: 'completed', observations: 'The page showed name [at] example [dot] edu in the header' });
    const result = parseOutcome(raw, ['snapshot: visible accessibility tree', 'click: Open pack']);
    expect(result.observations).toBe('The page showed [email] in the header');
  });
  it('removes full-width addresses split across fields', () => {
    expect(redactAcrossFields(['name\uff20', 'example\uff0ecom is shown'])).toEqual(['[email]', 'is shown']);
    expect(redactAcrossFields(['name \uff41\uff54', 'example \uff44\uff4f\uff54 com'])).toEqual(['[email]', '']);
    expect(redactAcrossFields(['Open pack\u2026', 'name at', 'example dot com'])).toEqual(['Open pack\u2026', '[email]', '']);
    const tasks: Record<string, unknown>[] = [{ steps: ['click: name\uff20'], observations: 'example\uff0ecom is shown' }];
    redactReportTasks(tasks);
    expect(tasks[0]).toEqual({ steps: ['click: [email]'], observations: 'is shown' });
  });
  it('keeps dollar patterns in click labels literal', () => {
    const tasks: Record<string, unknown>[] = [{ steps: ['click: Cost $1 pack', 'click: Tap $& now', 'not completed: click: Pay $$ then $` and $\''], observations: 'ok' }];
    redactReportTasks(tasks);
    expect(tasks[0]!.steps).toEqual(['click: Cost $1 pack', 'click: Tap $& now', "not completed: click: Pay $$ then $` and $'"]);
  });
  it('keeps measurements that use a spaced at sign', () => {
    for (const prose of ['rank 3 @ 12.5 seconds', 'Hit 9 @ 4.0x speed']) expect(clean(prose)).toBe(prose);
  });
  it('removes invisible and bidi marks inside an address', () => {
    for (const mark of ['\u2061', '\u2064', '\u061c', '\u034f', '\ufe0f', '\ufe00', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069', '\u00ad']) {
      expect(clean(`name@exa${mark}mple.com`)).toBe('[email]');
    }
    expect(clean('name\u0085at example dot com')).toBe('[email]');
  });
  it('keeps original characters where nothing is redacted (redacted text is NFKC-folded)', () => {
    expect(clean('Open pack\u2026 \u2122 \ufb01')).toBe('Open pack\u2026 \u2122 \ufb01');
    expect(clean('x\u2026 name\uff20example\uff0ecom')).toBe('x... [email]');
  });
  it('finishes the quadratic-looking chains at the report size cap', () => {
    // 16 KiB is the largest agent report; a backtracking blow-up would not finish at this size.
    for (const unit of ['x dot ', 'a.b ', 'x at ', 'x [dot] ']) {
      const started = performance.now();
      clean(unit.repeat(Math.floor(16384 / unit.length)) + 'end');
      expect(performance.now() - started).toBeLessThan(10000);
    }
  });
});

describe('local audit runner boundary', () => {
  it('gives the agent CLI an allowlisted environment without CI or GitHub secrets', () => {
    const env = agentEnvironment({
      PATH: '/usr/bin', HOME: '/home/audit', ANTHROPIC_API_KEY: 'agent-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', HTTPS_PROXY: 'http://proxy.invalid',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem', GITHUB_TOKEN: 'secret', GH_TOKEN: 'secret', ACTIONS_RUNTIME_TOKEN: 'secret', NPM_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'http://relay.invalid',
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CI: 'true', BASE_PATH: '/BrainrotTCG/', TERM: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/audit', ANTHROPIC_API_KEY: 'agent-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', HTTPS_PROXY: 'http://proxy.invalid', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' });
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

  it('finds every memory or rules file a reviewer session could load from its home or folders', () => {
    const directory = mkdtempSync(join(tmpdir(), 'brainrot-audit-memory-'));
    const home = join(directory, 'home');
    const task = join(directory, 'run', 'opening');
    // The real temporary directory or / may hold such files too; only this fixture is checked.
    const found = () => instructionFiles(home, task).filter((path) => path.startsWith(directory));
    try {
      mkdirSync(task, { recursive: true });
      mkdirSync(join(home, '.claude', 'rules'), { recursive: true });
      expect(found()).toEqual([join(home, '.claude', 'rules')]);
      rmSync(join(home, '.claude', 'rules'), { recursive: true });
      expect(found()).toEqual([]);
      mkdirSync(join(task, '.claude'));
      for (const path of [join(home, '.claude', 'CLAUDE.md'), join(directory, 'run', 'CLAUDE.local.md'), join(task, 'AGENTS.md'), join(task, '.claude', 'CLAUDE.md')]) writeFileSync(path, 'Coaching');
      expect(found()).toEqual([join(home, '.claude', 'CLAUDE.md'), join(task, 'AGENTS.md'), join(task, '.claude', 'CLAUDE.md'), join(directory, 'run', 'CLAUDE.local.md')]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('restricted browser adapter', () => {
  // Every page call yields first, as Playwright does, so concurrent commands interleave. The yield is a
  // promise turn, not a timer: the order commands run in doesn't depend on the clock.
  function fakePage(matches = 1) {
    const clicked: string[] = [];
    const pressed: string[] = [];
    const tick = () => Promise.resolve();
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

  it('does not count a step as evidence when the page cannot be read back', async () => {
    const { page } = fakePage();
    Object.assign(page, { locator: () => ({ ariaSnapshot: async () => { throw Error('Target closed'); } }) });
    const steps: string[] = [];
    await expect(browserCommand(page, { name: 'snapshot' }, steps)).rejects.toThrow('Target closed');
    expect(steps).toEqual(['not completed: snapshot: visible accessibility tree']);
  });

  // The real stdio MCP script against the real bridge handler, as the agent CLI would run them.
  async function callTools(endpoint: string, calls: unknown[]) {
    const script = fileURLToPath(new URL('./browser-mcp.mjs', import.meta.url));
    const child = spawn(process.execPath, [script], { env: { BRAINROT_AUDIT_ENDPOINT: endpoint }, stdio: ['pipe', 'pipe', 'ignore'] });
    const replies: { id: number; result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } }[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => replies.push(JSON.parse(line)));
    const closed = new Promise((resolve) => child.once('close', resolve));
    calls.forEach((params, id) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }) + '\n'));
    child.stdin.end();
    await closed;
    return replies;
  }

  it('passes adapter refusals to the agent as tool errors and keeps other failures generic', async () => {
    const { page } = fakePage(3);
    const token = 'ab'.repeat(24);
    const steps: string[] = [];
    const server = createServer(bridgeHandler(token, (command) => {
      if ((command as { name?: unknown }).name === 'wait') throw Error('PRIVATE_SAVE in a raw failure');
      return browserCommand(page, command, steps);
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const replies = await callTools(`http://127.0.0.1:${port}/${token}`, [
        { name: 'click', arguments: { role: 'button', name: 'Open pack' } },
        { name: 'wait', arguments: {} },
        { name: 'snapshot', arguments: {} },
      ]);
      expect(replies.map((reply) => reply.id)).toEqual([0, 1, 2]);
      expect(replies[0].result).toEqual({ content: [{ type: 'text', text: expect.stringMatching(/^3 visible buttons share that exact name/) }], isError: true });
      expect(replies[1].result).toEqual({ content: [{ type: 'text', text: 'Browser action blocked or unavailable' }], isError: true });
      expect(replies[2].result).toEqual({ content: [{ type: 'text', text: '- main' }] });
      expect(JSON.stringify(replies)).not.toContain('PRIVATE_SAVE');
      // Anything but the adapter's own 400 is an MCP protocol error with no detail.
      const [unknownBridge] = await callTools(`http://127.0.0.1:${port}/${'cd'.repeat(24)}`, [{ name: 'snapshot', arguments: {} }]);
      expect(unknownBridge).toMatchObject({ id: 0, error: { message: 'Audit browser operation unavailable' } });
      expect(unknownBridge.result).toBeUndefined();
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});
