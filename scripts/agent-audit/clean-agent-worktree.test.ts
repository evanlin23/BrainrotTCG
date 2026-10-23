import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Drives the SubagentStop hook (.claude/hooks/clean-agent-worktree.sh) against throwaway project
// folders: its stdin is the hook's JSON input and CLAUDE_PROJECT_DIR points at the fixture.
const scriptPath = join(process.cwd(), '.claude', 'hooks', 'clean-agent-worktree.sh');
const scratch = mkdtempSync(join(tmpdir(), 'brainrot-clean-worktree-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const BUILD_DIRS = ['node_modules', 'dist', 'test-results', 'playwright-report', 'blob-report'];

/** A project folder with one agent worktree holding source, a .git file and every build folder. */
function makeProject(agentId: string) {
  const project = mkdtempSync(join(scratch, 'project-'));
  const worktree = join(project, '.claude', 'worktrees', `agent-${agentId}`);
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  writeFileSync(join(worktree, 'src', 'main.ts'), 'export {};\n');
  writeFileSync(join(worktree, 'package.json'), '{}\n');
  for (const dir of BUILD_DIRS) {
    mkdirSync(join(worktree, dir, 'nested'), { recursive: true });
    writeFileSync(join(worktree, dir, 'nested', 'file.txt'), 'x');
  }
  return { project, worktree };
}

function runHook(project: string, input: unknown) {
  return spawnSync('bash', [scriptPath], {
    cwd: scratch,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
}

const stopInput = (agentId: unknown) => ({
  session_id: 'abc123',
  hook_event_name: 'SubagentStop',
  agent_id: agentId,
  agent_type: 'implementer',
  last_assistant_message: 'done',
});

describe('clean-agent-worktree hook', () => {
  it('removes only the build folders from the stopping agent worktree', () => {
    const { project, worktree } = makeProject('a1b2c3');
    const other = makeProject('zzz999').worktree;
    const otherInSameProject = join(project, '.claude', 'worktrees', 'agent-other');
    mkdirSync(join(otherInSameProject, 'node_modules'), { recursive: true });
    mkdirSync(join(project, 'node_modules'), { recursive: true });

    const result = runHook(project, stopInput('a1b2c3'));

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`Cleaned agent-a1b2c3 worktree: removed ${BUILD_DIRS.join(' ')}.`);
    for (const dir of BUILD_DIRS) expect(existsSync(join(worktree, dir))).toBe(false);
    expect(readFileSync(join(worktree, 'src', 'main.ts'), 'utf8')).toBe('export {};\n');
    expect(existsSync(join(worktree, 'package.json'))).toBe(true);
    expect(existsSync(join(worktree, '.git'))).toBe(true);
    expect(existsSync(join(otherInSameProject, 'node_modules'))).toBe(true);
    expect(existsSync(join(project, 'node_modules'))).toBe(true);
    expect(existsSync(join(other, 'node_modules'))).toBe(true);
  });

  it.each([
    ['a missing id', stopInput(undefined)],
    ['an empty id', stopInput('')],
    ['a path traversal id', stopInput('../../..')],
    ['an id with a slash', stopInput('a1b2c3/../a1b2c3')],
    ['a non-string id', stopInput(42)],
    ['invalid JSON', '{"agent_id": "a1b2c3"'],
  ])('does nothing for %s', (_label, input) => {
    const { project, worktree } = makeProject('a1b2c3');
    const result = runHook(project, input);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    for (const dir of BUILD_DIRS) expect(existsSync(join(worktree, dir))).toBe(true);
  });

  it('does nothing when the worktree folder does not exist', () => {
    const { project } = makeProject('a1b2c3');
    const result = runHook(project, stopInput('nosuchagent'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('does nothing when CLAUDE_PROJECT_DIR has no worktrees folder', () => {
    const project = mkdtempSync(join(scratch, 'bare-'));
    const result = runHook(project, stopInput('a1b2c3'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('does not follow an agent worktree symlink out of .claude/worktrees', () => {
    const { project } = makeProject('a1b2c3');
    const outside = makeProject('elsewhere').worktree;
    symlinkSync(outside, join(project, '.claude', 'worktrees', 'agent-escape'));

    const result = runHook(project, stopInput('escape'));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    for (const dir of BUILD_DIRS) expect(existsSync(join(outside, dir))).toBe(true);
  });

  it('does not follow a build-folder symlink out of the worktree', () => {
    const { project, worktree } = makeProject('a1b2c3');
    const outside = mkdtempSync(join(scratch, 'outside-'));
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    rmSync(join(worktree, 'dist'), { recursive: true });
    symlinkSync(outside, join(worktree, 'dist'));

    const result = runHook(project, stopInput('a1b2c3'));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('dist');
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('skips a folder that is not a git worktree', () => {
    const { project, worktree } = makeProject('a1b2c3');
    rmSync(join(worktree, '.git'));
    const result = runHook(project, stopInput('a1b2c3'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(join(worktree, 'node_modules'))).toBe(true);
  });

  it('keeps the build folders while a process still runs inside the worktree', () => {
    const { project, worktree } = makeProject('a1b2c3');
    const cwd = join(worktree, 'src');
    // spawn() returns only after the child has changed directory and exec'd, so its cwd is set.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
    try {
      const result = runHook(project, stopInput('a1b2c3'));
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`Kept agent-a1b2c3 build output: process ${child.pid} is still running in it.`);
      for (const dir of BUILD_DIRS) expect(existsSync(join(worktree, dir))).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
