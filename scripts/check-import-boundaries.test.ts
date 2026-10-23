import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';
import { checkImportBoundaries, EXCEPTIONS, formatViolations, layerOf, type BoundaryException } from './check-import-boundaries.ts';

const REAL_ROOT = fileURLToPath(new URL('../', import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway tree holding just these files (repo-relative path -> source); each imported file needs an entry too. */
const tree = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'import-boundaries-'));
  roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  return root;
};

const messages = (files: Record<string, string>, exceptions: readonly BoundaryException[] = []) =>
  checkImportBoundaries(tree(files), exceptions).violations.map((v) => `${v.file}:${v.line} ${v.message}`);

const CARD = { 'src/components/cards/Card.tsx': 'export interface CardWithMeta { id: string }\n' };

describe('the repository', () => {
  it('has no import-boundary violations, and every exception is still needed', () => {
    const { violations, files } = checkImportBoundaries(REAL_ROOT);
    expect(formatViolations(violations)).toBe('');
    expect(files).toBeGreaterThan(100);
  });

  it('would fail on each excepted import (the #700 CardWithMeta imports, a React type in game, confetti in utils) without its exception', () => {
    const { violations } = checkImportBoundaries(REAL_ROOT, []);
    expect(violations.map((v) => v.file).sort()).toEqual(EXCEPTIONS.map((e) => e.from).sort());
    for (const violation of violations) {
      const exception = EXCEPTIONS.find((e) => e.from === violation.file)!;
      expect(violation.message, violation.file).toContain(exception.to.startsWith('src/') ? `${exception.to}.tsx` : `UI package ${exception.to}`);
    }
  });

  it('marks every exception for a type import typeOnly', () => {
    const typeOnly = EXCEPTIONS.filter((e) => e.typeOnly).map((e) => e.from).sort();
    expect(typeOnly).toEqual(EXCEPTIONS.filter((e) => e.from !== 'src/utils/confettiEffects.ts').map((e) => e.from).sort());
  });

  it('gives every exception a reason, a removal condition and an owner issue', () => {
    expect(EXCEPTIONS.length).toBeGreaterThan(0);
    for (const exception of EXCEPTIONS) {
      expect(exception.reason.trim()).not.toBe('');
      expect(exception.removeWhen.trim()).not.toBe('');
      expect(exception.issue).toMatch(/^#\d+$/);
    }
  });

  it('puts every directory under src in a layer', () => {
    expect(layerOf('src/engine/pack.ts')).toBe('engine');
    expect(layerOf('src/App.tsx')).toBe('app');
    expect(layerOf('src/unclaimed/a.ts')).toBeUndefined();
  });
});

describe('forbidden imports', () => {
  it('fails a game module that imports a component type (the #700 mistake)', () => {
    const out = messages({ ...CARD, 'src/game/pulls.ts': "import type { CardWithMeta } from '../components/cards/Card';\nexport type X = CardWithMeta;\n" });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("src/game/pulls.ts:1 imports '../components/cards/Card'");
    expect(out[0]).toContain('game must not import components');
  });

  it.each([
    ['inline type specifier', "import { type CardWithMeta } from '../components/cards/Card';"],
    ['re-exported type', "export type { CardWithMeta } from '../components/cards/Card';"],
    ['star re-export', "export * from '../components/cards/Card';"],
    ['dynamic import', "export const load = () => import('../components/cards/Card');"],
    ['side-effect import', "import '../components/cards/Card';"],
    ['explicit extension', "import type { CardWithMeta } from '../components/cards/Card.tsx';"],
  ])('catches a %s', (_name, source) => {
    expect(messages({ ...CARD, 'src/game/a.ts': `${source}\n` })).toHaveLength(1);
  });

  it('catches an indirect barrel: the barrel is the file that breaks the rule', () => {
    const out = messages({
      ...CARD,
      'src/types/index.ts': "export type { CardWithMeta } from '../components/cards/Card';\n",
      'src/game/a.ts': "import type { CardWithMeta } from '../types';\nexport type X = CardWithMeta;\n",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('src/types/index.ts:1');
    expect(out[0]).toContain('types must not import components');
  });

  it('catches a tsconfig path alias', () => {
    const files = {
      ...CARD,
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@ui/*': ['src/components/*'] } } }),
      'src/game/a.ts': "import type { CardWithMeta } from '@ui/cards/Card';\n",
    };
    const out = messages(files);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("imports '@ui/cards/Card'");
  });

  it.each([
    ['game', "import { x } from '../hooks/useRoute';", 'game must not import hooks'],
    ['game', "import { x } from '../App';", 'game must not import app'],
    ['engine', "import { x } from '../game/player';", 'engine must not import game'],
    ['engine', "import { x } from '../content/sets';", 'engine must not import content'],
    ['hooks', "import { x } from '../components/cards/Card';", 'hooks must not import components'],
    ['components', "import { x } from '../App';", 'components must not import app'],
    ['utils', "import type { x } from '../components/cards/Card';", 'utils must not import components'],
    ['data', "import { x } from '../game/history';", 'data must not import game'],
  ])('fails %s code that does %s', (layer, source, expected) => {
    const files = {
      ...CARD,
      'src/App.tsx': '',
      'src/hooks/useRoute.ts': '',
      'src/game/player.ts': '',
      'src/game/history.ts': '',
      'src/content/sets/index.ts': '',
      [`src/${layer}/a.ts`]: `${source}\n`,
    };
    const out = messages(files);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(expected);
  });

  it('fails an engine module that imports React, a Node built-in or an unlisted package', () => {
    const out = messages({
      'src/engine/a.ts': "import { useState } from 'react';\n",
      'src/engine/b.ts': "import { readFileSync } from 'node:fs';\n",
      'src/engine/c.ts': "import confetti from 'canvas-confetti';\n",
    });
    expect(out).toHaveLength(3);
    for (const message of out) expect(message).toContain('engine may import only');
  });

  it('fails UI packages in layers that have no UI role', () => {
    const out = messages({ 'src/data/a.ts': "import type { ReactNode } from 'react';\n", 'src/workers/w.ts': "import { motion } from 'framer-motion';\n" });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('data must not import UI package react');
  });

  it('fails a new game, types or utils file that imports a UI package', () => {
    const out = messages({
      'src/game/new.ts': "import { useState } from 'react';\nexport const x = useState;\n",
      'src/types/new.ts': "import { motion } from 'framer-motion';\nexport const m = motion;\n",
      'src/utils/new.ts': "import type { ReactNode } from 'react';\nimport confetti from 'canvas-confetti';\nexport const c = confetti;\n",
    });
    expect(out).toHaveLength(4);
    expect(out[0]).toContain('src/game/new.ts:1');
    expect(out[0]).toContain('game must not import UI package react');
    expect(out[1]).toContain('types must not import UI package framer-motion');
    expect(out.join('\n')).toContain('utils must not import UI package canvas-confetti');
  });

  it('fails scripts that import UI, and production code that imports test code', () => {
    const out = messages({
      'src/components/Card.tsx': '',
      'src/test/helper.ts': '',
      'scripts/tool.ts': "import { Card } from '../src/components/Card';\n",
      'src/game/a.ts': "import { helper } from '../test/helper';\n",
    });
    expect(out).toHaveLength(2);
    expect(out.join('\n')).toContain('scripts must not import components');
    expect(out.join('\n')).toContain('game must not import test code');
  });

  it('fails a directory or file under src that no layer claims', () => {
    const out = messages({ 'src/newlayer/a.ts': 'export const a = 1;\n', 'src/stray.ts': 'export const b = 1;\n' });
    expect(out).toHaveLength(2);
    for (const message of out) expect(message).toContain('belongs to no layer');
  });

  it('fails an import of an unclaimed directory', () => {
    const out = messages({ 'src/newlayer/a.ts': '', 'src/game/b.ts': "import { a } from '../newlayer/a';\n" });
    expect(out.some((message) => message.includes('src/game/b.ts:1') && message.includes('belongs to no layer'))).toBe(true);
  });
});

describe('allowed imports', () => {
  it('passes imports that follow the map', () => {
    const out = messages({
      'src/engine/pack.ts': "import { sha256 } from '@noble/hashes/sha2.js';\nimport { argon2id } from 'hash-wasm';\nimport { b } from './bytes';\nexport const a = 1;\n",
      'src/engine/bytes.ts': 'export const b = 1;\n',
      'src/content/sets/index.ts': "import type { SetDefinition } from '../../engine';\n",
      'src/engine/index.ts': '',
      'src/game/a.ts': "import type { SetDefinition } from '../engine';\nimport { b } from '../utils/b';\n",
      'src/utils/b.ts': 'export const b = 1;\n',
      'src/hooks/useRoute.ts': "import { a } from '../game/a';\nimport { useState } from 'react';\n",
      'src/components/Card.tsx': "import { a } from '../game/a';\nimport { useRoute } from '../hooks/useRoute';\nimport { p } from '../engine';\nimport '../styles/card.css';\nimport art from '../assets/art.webp';\n",
      'src/styles/card.css': '',
      'src/assets/art.webp': '',
      'src/App.tsx': "import Card from './components/Card';\n",
      'src/main.tsx': "import App from './App';\n",
      'scripts/tool.ts': "import { b } from '../src/engine/bytes.ts';\nimport { a } from '../src/game/a.ts';\nimport { r } from './other.ts';\n",
      'scripts/other.ts': '',
    });
    expect(out).toEqual([]);
  });

  it('lets test files cross layers', () => {
    const out = messages({
      ...CARD,
      'src/game/a.test.ts': "import type { CardWithMeta } from '../components/cards/Card';\n",
      'src/engine/a.test.ts': "import { sets } from '../content/sets';\nimport { p } from '../test/property';\n",
      'src/test/mountedApp.ts': "import App from '../App';\nimport { x } from '../components/cards/Card';\n",
      'src/App.tsx': '',
      'src/main.test.tsx': "import './main';\n",
      'tests/browser/a.spec.ts': "import { x } from '../../src/game/a';\n",
    });
    expect(out).toEqual([]);
  });
});

describe('exceptions', () => {
  const exception: BoundaryException = {
    from: 'src/game/pulls.ts',
    to: 'src/components/cards/Card',
    reason: 'type lives in the component',
    issue: '#700',
    removeWhen: 'the type moves to a neutral module',
  };
  const files = { ...CARD, 'src/game/pulls.ts': "import type { CardWithMeta } from '../components/cards/Card';\n" };

  it('allows exactly the listed import', () => {
    expect(messages(files, [exception])).toEqual([]);
    expect(messages({ ...files, 'src/game/other.ts': "import type { CardWithMeta } from '../components/cards/Card';\n" }, [exception])).toHaveLength(1);
    expect(messages({ ...files, 'src/components/cards/Other.tsx': '', 'src/game/pulls.ts': "import {} from '../components/cards/Other';\n" }, [exception]).join('\n')).toContain('matches no import any more');
  });

  it('fails an exception once its import is gone, naming the removal condition', () => {
    const out = messages({ ...CARD, 'src/game/pulls.ts': 'export const x = 1;\n' }, [exception]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('matches no import any more');
    expect(out[0]).toContain('the type moves to a neutral module');
  });

  describe('for a package', () => {
    const react: BoundaryException = { from: 'src/game/style.ts', to: 'react', typeOnly: true, reason: 'a style type', issue: '#711', removeWhen: 'the type is local' };
    const run = (source: string, list: readonly BoundaryException[] = [react]) => messages({ 'src/game/style.ts': source }, list);

    it('allows the listed file to import the listed package, and no other file or package', () => {
      expect(run("import type React from 'react';\nexport type S = React.CSSProperties;\n")).toEqual([]);
      expect(messages({ 'src/game/style.ts': "import type React from 'react';\n", 'src/game/other.ts': "import type React from 'react';\n" }, [react])).toHaveLength(1);
      expect(run("import type { motion } from 'framer-motion';\nimport type React from 'react';\n").join('\n')).toContain('must not import UI package framer-motion');
      expect(run('export const x = 1;\n').join('\n')).toContain('matches no import any more');
    });

    it('fails a run-time import under a type-only exception, but not a type-only one', () => {
      for (const source of [
        "import { useState } from 'react';\n",
        "import React from 'react';\n",
        "import * as React from 'react';\n",
        "import './setup';\nimport {} from 'react';\n",
        "import { type A, useState } from 'react';\n",
        "export { useState } from 'react';\n",
        "export const load = () => import('react');\n",
      ]) {
        const out = run(source, [react]).filter((message) => !message.includes('./setup'));
        expect(out, source).toHaveLength(1);
        expect(out[0], source).toContain('covers a type import only, and this one is used at run time');
      }
      for (const source of [
        "import type { A } from 'react';\n",
        "import type React from 'react';\n",
        "import { type A, type B } from 'react';\n",
        "export type { A } from 'react';\n",
        "export { type A } from 'react';\n",
      ]) expect(run(source), source).toEqual([]);
    });

    it('lets an exception without typeOnly cover a run-time import', () => {
      expect(run("import { useState } from 'react';\n", [{ ...react, typeOnly: undefined }])).toEqual([]);
    });

    it('fails a run-time import under a type-only file exception', () => {
      const card: BoundaryException = { from: 'src/game/pulls.ts', to: 'src/components/cards/Card', typeOnly: true, reason: 'type lives in the component', issue: '#700', removeWhen: 'it moves' };
      const out = messages({ ...CARD, 'src/game/pulls.ts': "import { CardWithMeta } from '../components/cards/Card';\nexport const x = CardWithMeta;\n" }, [card]);
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('src/game/pulls.ts:1');
      expect(out[0]).toContain('covers a type import only');
    });
  });

  it('rejects an exception with no reason, removal condition or owner issue', () => {
    expect(messages(files, [{ ...exception, reason: ' ' }]).join('\n')).toContain('needs reason');
    expect(messages(files, [{ ...exception, removeWhen: '' }]).join('\n')).toContain('needs removeWhen');
    expect(messages(files, [{ ...exception, issue: 'later' }]).join('\n')).toContain('owner issue');
  });
});

describe('src/engine globals (ESLint)', () => {
  const lint = async (filePath: string, source: string) => {
    const eslint = new ESLint({ cwd: REAL_ROOT });
    const [result] = await eslint.lintText(source, { filePath: path.join(REAL_ROOT, filePath) });
    return result.messages.filter((m) => m.ruleId === 'no-restricted-globals' || m.ruleId === 'no-restricted-properties').map((m) => m.message);
  };

  it('rejects DOM and storage globals in engine code', async () => {
    expect(await lint('src/engine/probe.ts', 'export const a = () => window.name;\n')).toHaveLength(1);
    expect(await lint('src/engine/probe.ts', 'export const a = () => localStorage.getItem("k");\n')).toHaveLength(1);
    expect(await lint('src/engine/probe.ts', 'export const a = () => document.title;\n')).toHaveLength(1);
  });

  it('rejects network and worker globals in engine code', async () => {
    expect(await lint('src/engine/probe.ts', 'export const a = () => fetch("/x");\n')).toHaveLength(1);
    expect(await lint('src/engine/probe.ts', 'export const a = () => new XMLHttpRequest();\n')).toHaveLength(1);
    expect(await lint('src/engine/probe.ts', 'export const a = () => new Worker("w.js");\n')).toHaveLength(1);
  });

  it('rejects the same globals reached through globalThis or self, but not an alias', async () => {
    expect(await lint('src/engine/probe.ts', 'export const a = () => globalThis.localStorage;\n')).toHaveLength(1);
    expect(await lint('src/engine/probe.ts', 'export const a = () => self.document;\n')).toHaveLength(1);
    expect(await lint('src/engine/probe.ts', 'export const a = () => globalThis.fetch("/x");\n')).toHaveLength(1);
    // The documented gap: an alias hides the global from a syntax rule.
    expect(await lint('src/engine/probe.ts', 'const g = globalThis;\nexport const a = () => g.localStorage;\n')).toEqual([]);
    expect(await lint('src/engine/probe.ts', 'export const a = () => globalThis.crypto;\n')).toEqual([]);
  });

  it('allows the same globals outside engine code, and in engine tests', async () => {
    expect(await lint('src/game/probe.ts', 'export const a = () => window.localStorage.getItem("k");\n')).toEqual([]);
    expect(await lint('src/engine/probe.test.ts', 'export const a = () => document.title;\n')).toEqual([]);
    expect(await lint('src/game/probe.ts', 'export const a = () => [globalThis.localStorage, fetch("/x")];\n')).toEqual([]);
  });

  it('allows what the engine needs in a worker and Node', async () => {
    expect(await lint('src/engine/probe.ts', 'export const a = () => [performance.now(), new TextEncoder(), crypto.getRandomValues(new Uint8Array(1))];\n')).toEqual([]);
  });
});
