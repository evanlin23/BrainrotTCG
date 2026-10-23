import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isMainModule } from './main-module.ts';

/**
 * Architecture guard (#711): the layers in CLAUDE.md and docs/ARCHITECTURE.md as an import map.
 * `npm run check` runs it through `npm run check:imports`. It reads every non-test source file under
 * src/ and scripts/ with TypeScript's own import scanner, so `import type`, `import { type X }`,
 * `export ... from`, `import()` and tsconfig `paths` aliases all count, and it resolves each target
 * to a repo path before judging it. A barrel can't hide a violation: the barrel is itself a file in
 * a layer, and its own `export ... from` is checked against that layer's list.
 *
 * Not covered (docs/DEVELOPMENT.md, Import boundaries): browser globals and DOM types used without
 * an import (src/engine has a separate ESLint rule for them), `import.meta.glob`, and cycles between
 * files of different layers that both directions allow today (game <-> utils, game <-> types).
 */

export type Layer =
  | 'engine' | 'content' | 'constants' | 'styles' | 'types' | 'data' | 'utils' | 'game'
  | 'workers' | 'hooks' | 'components' | 'app' | 'assets' | 'scripts' | 'spec' | 'tests' | 'test' | 'other';

/** What each layer's non-test files may import from another layer (its own layer is always allowed). */
export const ALLOWED_LAYERS: Readonly<Partial<Record<Layer, readonly Layer[]>>> = {
  // Deterministic rules: no React, DOM, storage or other layers (runs in the browser, a worker and Node).
  engine: [],
  content: ['engine'],
  constants: ['assets'],
  styles: ['engine'],
  types: ['engine', 'content', 'data', 'game'],
  data: ['engine', 'content', 'styles'],
  utils: ['engine', 'content', 'constants', 'data', 'game', 'types'],
  // Browser and storage code. Never UI: no components, hooks or App.
  game: ['engine', 'content', 'constants', 'data', 'styles', 'types', 'utils', 'workers', 'assets'],
  workers: ['engine'],
  hooks: ['engine', 'content', 'constants', 'data', 'game', 'styles', 'types', 'utils'],
  components: ['engine', 'content', 'constants', 'data', 'game', 'hooks', 'styles', 'types', 'utils', 'assets'],
  app: ['engine', 'content', 'constants', 'data', 'game', 'hooks', 'components', 'styles', 'types', 'utils', 'assets'],
  // Node tools import the rules instead of copying them; they never import UI.
  scripts: ['engine', 'content', 'game', 'styles', 'tests'],
};

/** Packages a layer may import (a bare specifier, or a subpath of one). A layer not listed here is unrestricted. */
export const ALLOWED_PACKAGES: Readonly<Partial<Record<Layer, readonly string[]>>> = {
  engine: ['hash-wasm', '@noble/ed25519', '@noble/hashes'],
};
/** UI and DOM packages that layers with no UI role must not import. */
export const UI_PACKAGES: readonly string[] = ['react', 'react-dom', 'framer-motion', 'lucide-react', 'canvas-confetti'];
export const NO_UI_PACKAGES: readonly Layer[] = ['content', 'constants', 'styles', 'data', 'workers', 'game', 'types', 'utils'];

/**
 * A narrowly necessary exception: one file's import of one target. It needs a reason, an owner issue
 * and the condition that removes it. An exception that no longer matches an import fails the check,
 * so it can't outlive its fix.
 */
export interface BoundaryException {
  /** Importing file, repo-relative. */
  from: string;
  /** Imported file, repo-relative, without its extension, or a package name such as `react`. */
  to: string;
  /** The reason covers only a type import: a runtime import of the same target still fails. */
  typeOnly?: boolean;
  reason: string;
  /** The issue that removes it, as `#n`. */
  issue: string;
  removeWhen: string;
}

const CARD_WITH_META = {
  to: 'src/components/cards/Card',
  typeOnly: true,
  reason: 'CardWithMeta (card data plus reveal-only UI state) is defined in the Card component, so this type-only import points the wrong way.',
  issue: '#700',
  removeWhen: 'CardWithMeta and its card-instance types live in a neutral module that this file imports instead of the component.',
} as const;

export const EXCEPTIONS: readonly BoundaryException[] = [
  { from: 'src/game/bestSources.ts', ...CARD_WITH_META },
  { from: 'src/game/history.ts', ...CARD_WITH_META },
  { from: 'src/game/pulls.ts', ...CARD_WITH_META },
  { from: 'src/types/index.ts', ...CARD_WITH_META },
  { from: 'src/utils/achievementChecks.ts', ...CARD_WITH_META },
  {
    from: 'src/game/modifiers.ts',
    to: 'react',
    typeOnly: true,
    reason: 'modifierStyle() is typed as React.CSSProperties so components can pass it to `style`; the import is erased at build time.',
    issue: '#711',
    removeWhen: 'the style type is a plain Record<string, string | number> (or a neutral type module) and modifiers.ts imports nothing from react.',
  },
  {
    from: 'src/utils/confettiEffects.ts',
    to: 'canvas-confetti',
    reason: 'The confetti burst is a browser canvas effect that lives in utils and is called from UI code.',
    issue: '#711',
    removeWhen: 'confettiEffects moves to src/components (or a hook) and src/utils imports no UI package.',
  },
];

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.git', '.claude']);
/** The directories whose files are checked. */
export const SCANNED_ROOTS = ['src', 'scripts'] as const;

const SRC_DIRECTORY_LAYERS: Readonly<Record<string, Layer>> = {
  engine: 'engine', content: 'content', constants: 'constants', styles: 'styles', types: 'types', data: 'data',
  utils: 'utils', game: 'game', workers: 'workers', hooks: 'hooks', components: 'components', assets: 'assets', test: 'test',
};
const SRC_ROOT_FILES = new Set(['App.tsx', 'main.tsx', 'vite-env.d.ts']);

const toPosix = (p: string) => p.split(path.sep).join('/');
const withoutExtension = (p: string) => p.replace(SOURCE_EXTENSIONS, '');

/** The layer of a repo-relative path, or undefined for a path under src/ that no layer claims. */
export const layerOf = (repoPath: string): Layer | undefined => {
  const parts = repoPath.split('/');
  if (parts[0] === 'src') {
    if (parts.length === 2) return SRC_ROOT_FILES.has(parts[1]) ? 'app' : undefined;
    return SRC_DIRECTORY_LAYERS[parts[1]];
  }
  if (parts[0] === 'scripts') return 'scripts';
  if (parts[0] === 'spec') return 'spec';
  if (parts[0] === 'tests') return 'tests';
  return 'other';
};

/** Test code (unit tests, the shared test helpers in src/test, the browser specs) may cross layers. */
const isTestFile = (repoPath: string) => TEST_FILE.test(repoPath) || layerOf(repoPath) === 'test' || layerOf(repoPath) === 'tests';

export interface Violation {
  file: string;
  line: number;
  message: string;
}

export interface BoundaryResult {
  violations: Violation[];
  /** Non-test files checked. */
  files: number;
}

const listSourceFiles = (root: string, dir: string, out: string[]) => {
  const absolute = path.join(root, dir);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) listSourceFiles(root, child, out);
    else if (SOURCE_EXTENSIONS.test(entry.name)) out.push(child);
  }
};

const compilerOptionsFor = (root: string): ts.CompilerOptions => {
  const configPath = path.join(root, 'tsconfig.json');
  const base: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, resolveJsonModule: true, jsx: ts.JsxEmit.ReactJSX };
  if (!existsSync(configPath)) return base;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(`tsconfig.json: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  return { ...base, ...parsed.options, noEmit: true };
};

/**
 * The module specifiers a file imports at run time: anything but `import type`, `import { type X }`
 * (every name a type), `export type` and `export { type X } from`. `import()` and `require()` count.
 */
const runtimeSpecifiers = (file: string, text: string): Set<string> => {
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)));
      if (!onlyTypes) found.add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const onlyTypes = node.isTypeOnly || (!!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly));
      if (!onlyTypes) found.add(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      if (!node.isTypeOnly) found.add(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) found.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  return found;
};

type Resolved = { kind: 'file'; path: string } | { kind: 'package'; name: string };

const packageName = (specifier: string) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
const packageMatches = (specifier: string, allowed: string) => specifier === allowed || specifier.startsWith(`${allowed}/`);

export const checkImportBoundaries = (root: string, exceptions: readonly BoundaryException[] = EXCEPTIONS): BoundaryResult => {
  const options = compilerOptionsFor(root);
  const cache = ts.createModuleResolutionCache(root, (name) => name, options);
  const violations: Violation[] = [];

  const resolve = (specifier: string, fromFile: string): Resolved => {
    const bare = specifier.replace(/\?.*$/, '');
    const containing = path.join(root, fromFile);
    const hit = ts.resolveModuleName(bare, containing, options, ts.sys, cache).resolvedModule;
    if (hit && !hit.isExternalLibraryImport) return { kind: 'file', path: toPosix(path.relative(root, hit.resolvedFileName)) };
    // Images, stylesheets and files TypeScript doesn't resolve: judge the path itself.
    if (bare.startsWith('.')) return { kind: 'file', path: toPosix(path.relative(root, path.resolve(path.dirname(containing), bare))) };
    return { kind: 'package', name: bare };
  };

  for (const exception of exceptions) {
    const missing = [
      ...(['reason', 'removeWhen'] as const).filter((key) => !exception[key].trim()),
      ...(/^#\d+$/.test(exception.issue) ? [] : ['an owner issue like #700']),
    ];
    if (missing.length) violations.push({ file: exception.from, line: 0, message: `exception for ${exception.to} needs ${missing.join(' and ')}` });
  }
  const used = new Set<BoundaryException>();

  const files: string[] = [];
  for (const dir of SCANNED_ROOTS) listSourceFiles(root, dir, files);
  let checked = 0;

  for (const file of files) {
    if (isTestFile(file)) continue;
    const from = layerOf(file);
    if (from === undefined) {
      violations.push({ file, line: 1, message: 'belongs to no layer: add its directory to SRC_DIRECTORY_LAYERS and ALLOWED_LAYERS in scripts/check-import-boundaries.ts' });
      continue;
    }
    checked++;
    const text = readFileSync(path.join(root, file), 'utf8');
    const info = ts.preProcessFile(text, true, true);
    let runtime: Set<string> | undefined;
    const allowed = ALLOWED_LAYERS[from] ?? [];
    for (const imported of info.importedFiles) {
      const line = text.slice(0, imported.pos).split('\n').length;
      const specifier = imported.fileName;
      const target = resolve(specifier, file);
      const fail = (message: string) => violations.push({ file, line, message: `imports '${specifier}': ${message}` });
      /** The exception for this file's import of `to`, if it covers it; a type-only one fails a run-time import. */
      const excepted = (to: string) => {
        const exception = exceptions.find((candidate) => candidate.from === file && candidate.to === to);
        if (!exception) return false;
        used.add(exception);
        runtime ??= runtimeSpecifiers(file, text);
        if (exception.typeOnly && runtime.has(specifier)) fail(`the exception for ${to} (${exception.issue}) covers a type import only, and this one is used at run time`);
        return true;
      };

      if (target.kind === 'package') {
        const name = packageName(target.name);
        const packages = ALLOWED_PACKAGES[from];
        if (packages && !packages.some((allowedName) => packageMatches(target.name, allowedName))) {
          fail(`${from} may import only ${packages.join(', ')} from outside the repo (${name} isn't one)`);
        } else if (NO_UI_PACKAGES.includes(from) && UI_PACKAGES.some((ui) => packageMatches(target.name, ui)) && !excepted(name)) {
          fail(`${from} must not import UI package ${name}`);
        }
        continue;
      }

      const to = layerOf(target.path);
      if (to === undefined) {
        fail(`${target.path} belongs to no layer: add it to SRC_DIRECTORY_LAYERS in scripts/check-import-boundaries.ts`);
        continue;
      }
      if (to === from) continue;
      if (to === 'test' || (TEST_FILE.test(target.path) && to !== 'tests') || (to === 'tests' && from !== 'scripts')) {
        fail(`${from} must not import test code (${target.path})`);
        continue;
      }
      if (allowed.includes(to)) continue;
      if (excepted(withoutExtension(target.path))) continue;
      fail(`${from} must not import ${to} (${target.path}); ${from} may import ${allowed.length ? allowed.join(', ') : 'nothing from another layer'}`);
    }
  }

  for (const exception of exceptions) {
    if (!used.has(exception)) {
      violations.push({
        file: exception.from,
        line: 0,
        message: `exception for ${exception.to} (${exception.issue}) matches no import any more: remove it from EXCEPTIONS in scripts/check-import-boundaries.ts. Removal condition was: ${exception.removeWhen}`,
      });
    }
  }
  return { violations, files: checked };
};

export const formatViolations = (violations: readonly Violation[]) =>
  violations.map((v) => `  ${v.file}${v.line ? `:${v.line}` : ''} ${v.message}`).join('\n');

if (isMainModule(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { violations, files } = checkImportBoundaries(root);
  if (violations.length) {
    console.error(`Import boundaries: ${violations.length} violation${violations.length === 1 ? '' : 's'} (map and exceptions: scripts/check-import-boundaries.ts, docs/DEVELOPMENT.md)\n${formatViolations(violations)}`);
    process.exit(1);
  }
  console.log(`Import boundaries: ${files} files checked, ${EXCEPTIONS.length} documented exception${EXCEPTIONS.length === 1 ? '' : 's'}`);
}
