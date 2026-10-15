import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isMainModule } from './main-module.ts';

describe('isMainModule', () => {
  let dir: string;
  let script: string;
  let other: string;
  let url: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'main-module-'));
    mkdirSync(path.join(dir, 'real'));
    script = path.join(dir, 'real', 'gate.ts');
    other = path.join(dir, 'real', 'other.ts');
    writeFileSync(script, '');
    writeFileSync(other, '');
    url = pathToFileURL(script).href;
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is the main module when started directly', () => {
    expect(isMainModule(url, script)).toBe(true);
  });

  it('is the main module when started through a symlinked file', () => {
    const link = path.join(dir, 'gate-link.ts');
    symlinkSync(script, link);
    expect(isMainModule(url, link)).toBe(true);
  });

  it('is the main module when started through a symlinked directory', () => {
    const linkedDir = path.join(dir, 'linked');
    symlinkSync(path.join(dir, 'real'), linkedDir);
    expect(isMainModule(url, path.join(linkedDir, 'gate.ts'))).toBe(true);
  });

  it('is not the main module when another file was started', () => {
    expect(isMainModule(url, other)).toBe(false);
    const link = path.join(dir, 'other-link.ts');
    symlinkSync(other, link);
    expect(isMainModule(url, link)).toBe(false);
  });

  it('is not the main module without a script path', () => {
    expect(isMainModule(url, undefined)).toBe(false);
    expect(isMainModule(url, '')).toBe(false);
  });

  it('falls back to absolute paths when a path cannot be resolved', () => {
    const missing = path.join(dir, 'missing.ts');
    expect(isMainModule(pathToFileURL(missing).href, missing)).toBe(true);
    expect(isMainModule(url, missing)).toBe(false);
  });
});
