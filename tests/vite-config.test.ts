import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
// Vite's public entry (its package exports), resolved from the checkout: the script runs elsewhere.
const vite = pathToFileURL(createRequire(join(root, 'package.json')).resolve('vite')).href;

it('stamps the checkout revision even when the build starts outside it', () => {
  const outside = mkdtempSync(join(tmpdir(), 'brainrot-vite-cwd-'));
  try {
    const script = `const { loadConfigFromFile } = await import(${JSON.stringify(vite)});
const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, ${JSON.stringify(join(root, 'vite.config.ts'))}, undefined, 'silent');
process.stdout.write(loaded.config.define.__BUILD_REVISION__);`;
    // A synchronous child blocks the worker, so the hang timeout can't stop it: each has its own
    // (docs/DEVELOPMENT.md, Test timing). The config load takes about 1 s.
    const stamped = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: outside, encoding: 'utf8', timeout: 60_000 });
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 60_000 }).trim();
    expect(stamped).toBe(JSON.stringify(revision));
  } finally { rmSync(outside, { recursive: true, force: true }); }
});
