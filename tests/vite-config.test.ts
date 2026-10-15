import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

it('stamps the checkout revision even when the build starts outside it', () => {
  const outside = mkdtempSync(join(tmpdir(), 'brainrot-vite-cwd-'));
  try {
    const script = `const { loadConfigFromFile } = await import(${JSON.stringify(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href)});
const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, ${JSON.stringify(join(root, 'vite.config.ts'))}, undefined, 'silent');
process.stdout.write(loaded.config.define.__BUILD_REVISION__);`;
    const stamped = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: outside, encoding: 'utf8' });
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    expect(stamped).toBe(JSON.stringify(revision));
  } finally { rmSync(outside, { recursive: true, force: true }); }
}, 30000);
