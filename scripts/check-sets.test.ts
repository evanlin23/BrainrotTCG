import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CardDefinition, Rarity, SetDefinition } from '../src/engine/index.ts';

/**
 * check-sets.ts runs on import and has its paths built into it, so each test copies it into a
 * throwaway tree (its own registry, lock file and images) and runs that copy with tsx. The real
 * src/content/sets.lock.json, content/sets and vectors are never read or written.
 */
const REAL_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REAL_LOCK = `${REAL_ROOT}src/content/sets.lock.json`;
const TSX = createRequire(import.meta.url).resolve('tsx/cli');

const card = (id: string, rarity: Rarity = 'COMMON'): CardDefinition => ({ id, name: id, rarity });

const set = (id: string, over: Partial<SetDefinition> = {}): SetDefinition => ({
  id,
  version: 1,
  name: id,
  era: 'test',
  releasedAt: '2026-01-01',
  packSize: 3,
  odds: { COMMON: 5000, UNCOMMON: 2500, RARE: 1500, EPIC: 700, LEGENDARY: 250, BRAINROT: 50 },
  holoOdds: 500,
  cards: [card(`${id}-a`), card(`${id}-b`, 'RARE'), card(`${id}-c`, 'EPIC')],
  ...over,
});

interface Tree {
  root: string;
  lockPath: string;
  setsDir: string;
  writeRegistry(sets: SetDefinition[]): void;
  writeLock(lock: Record<string, string>): void;
  /** Locks the current registry the way `--update` does, without running it again. */
  lock(): void;
  readLockText(): string | undefined;
  /** Every image a set needs. `art` picks the art file kind per card (none by default). */
  addAssets(s: SetDefinition, opts?: { wrapper?: boolean; art?: 'svg' | 'png' | 'card.png' }): void;
  run(...args: string[]): { status: number | null; stdout: string; stderr: string };
}

const trees: string[] = [];

/** What `--update` writes for these sets, from one real run per distinct registry. The hash covers set data only, never images. */
const locks = new Map<string, Record<string, string>>();
const lockFor = (sets: SetDefinition[]): Record<string, string> => {
  const key = JSON.stringify(sets);
  let lock = locks.get(key);
  if (!lock) {
    const t = makeTree(sets);
    t.run('--update');
    lock = JSON.parse(t.readLockText()!) as Record<string, string>;
    locks.set(key, lock);
  }
  return lock;
};

const makeTree = (sets: SetDefinition[], opts: { assets?: boolean } = {}): Tree => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'check-sets-test-'));
  trees.push(root);
  const mk = (rel: string) => mkdirSync(path.join(root, rel), { recursive: true });
  mk('scripts/cards');
  mk('src/content/sets');
  writeFileSync(path.join(root, 'package.json'), '{ "type": "module" }\n');
  copyFileSync(`${REAL_ROOT}scripts/check-sets.ts`, path.join(root, 'scripts/check-sets.ts'));
  // lib.ts derives its art folder from its own location, so it is copied; what it only reads is linked.
  copyFileSync(`${REAL_ROOT}scripts/cards/lib.ts`, path.join(root, 'scripts/cards/lib.ts'));
  for (const f of ['frame.ts', 'text.ts', 'fonts', 'templates']) symlinkSync(`${REAL_ROOT}scripts/cards/${f}`, path.join(root, 'scripts/cards', f));
  symlinkSync(`${REAL_ROOT}src/engine`, path.join(root, 'src/engine'));
  symlinkSync(`${REAL_ROOT}node_modules`, path.join(root, 'node_modules'));

  const setsDir = path.join(root, 'src/content/sets');
  let registry: SetDefinition[] = [];
  const lockPath = path.join(root, 'src/content/sets.lock.json');
  const tree: Tree = {
    root,
    lockPath,
    setsDir,
    writeRegistry: (s) => {
      registry = s;
      writeFileSync(path.join(setsDir, 'index.ts'), `export const ALL_SET_VERSIONS = ${JSON.stringify(s)};\n`);
    },
    lock: () => tree.writeLock(lockFor(registry)),
    writeLock: (lock) => writeFileSync(lockPath, JSON.stringify(lock)),
    readLockText: () => (existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : undefined),
    addAssets: (s, o = {}) => {
      const dir = path.join(setsDir, s.id);
      mkdirSync(path.join(dir, 'cards'), { recursive: true });
      mkdirSync(path.join(dir, 'art'), { recursive: true });
      if (o.wrapper !== false) {
        writeFileSync(path.join(dir, 'pack.webp'), '');
        writeFileSync(path.join(dir, 'pack-thumb.webp'), '');
      }
      for (const c of s.cards) {
        writeFileSync(path.join(dir, 'cards', `${c.id}.webp`), '');
        if (o.art) writeFileSync(path.join(dir, 'art', o.art === 'svg' ? `${c.id}.svg` : o.art === 'png' ? `${c.id}.png` : `${c.id}.card.png`), '');
      }
    },
    run: (...args) => {
      const r = spawnSync(process.execPath, [TSX, path.join(root, 'scripts/check-sets.ts'), ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
  tree.writeRegistry(sets);
  if (opts.assets !== false) for (const s of sets) tree.addAssets(s, { art: 'png' });
  return tree;
};

const errorLines = (stderr: string) => stderr.split('\n').filter(Boolean);

let realLockBefore: string;
beforeAll(() => {
  realLockBefore = readFileSync(REAL_LOCK, 'utf8');
});
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});
afterAll(() => {
  expect(readFileSync(REAL_LOCK, 'utf8')).toBe(realLockBefore);
});

describe('check-sets', () => {
  describe('a consistent registry, lock and image tree', () => {
    it('locks new set versions with --update, then passes on the next check', () => {
      const sets = [set('alpha'), set('alpha', { version: 2, modifiers: 1 }), set('beta')];
      const t = makeTree(sets);

      const update = t.run('--update');
      expect(update.stderr).toBe('');
      expect(update.status).toBe(0);
      expect(update.stdout).toBe('locked alpha@1\nlocked alpha@2\nlocked beta@1\n✓ 3 set version(s) OK\n');

      const lockText = t.readLockText()!;
      const lock = JSON.parse(lockText) as Record<string, string>;
      // Sorted keys, 2-space indent, trailing newline, one sha256 per set version.
      expect(Object.keys(lock)).toEqual(['alpha@1', 'alpha@2', 'beta@1']);
      expect(Object.values(lock).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
      expect(new Set(Object.values(lock)).size).toBe(3);
      expect(lockText).toBe(JSON.stringify(lock, null, 2) + '\n');

      const check = t.run();
      expect(check).toEqual({ status: 0, stdout: '✓ 3 set version(s) OK\n', stderr: '' });
      expect(t.readLockText()).toBe(lockText);
    });

    it('does not rewrite the lock when --update has nothing to add', () => {
      const t = makeTree([set('alpha')]);
      t.lock();
      // Same hashes, but a lock the script would never write: untouched means nothing was added.
      const lock = JSON.parse(t.readLockText()!) as Record<string, string>;
      const odd = JSON.stringify(lock);
      t.writeLock(lock);
      const again = t.run('--update');
      expect(again).toEqual({ status: 0, stdout: '✓ 1 set version(s) OK\n', stderr: '' });
      expect(t.readLockText()).toBe(odd);
    });

    it('adds new versions on --update and keeps the existing entries as they were', () => {
      const t = makeTree([set('alpha')]);
      t.lock();
      const alphaHash = (JSON.parse(t.readLockText()!) as Record<string, string>)['alpha@1'];

      const next = [set('alpha'), set('beta')];
      t.writeRegistry(next);
      t.addAssets(next[1], { art: 'png' });
      const r = t.run('--update');
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('locked beta@1\n✓ 2 set version(s) OK\n');
      const lock = JSON.parse(t.readLockText()!) as Record<string, string>;
      expect(Object.keys(lock)).toEqual(['alpha@1', 'beta@1']);
      expect(lock['alpha@1']).toBe(alphaHash);
    });

    it('lets names, captions, flavor, art notes, palette and release dates change after release', () => {
      const s = set('alpha');
      const t = makeTree([s]);
      t.lock();

      const edited: SetDefinition = {
        ...s,
        name: 'Renamed',
        era: 'another era',
        tagline: 'new tagline',
        releasedAt: '2027-02-02',
        palette: ['#000000'],
        cards: s.cards.map((c) => ({ ...c, name: `${c.name} renamed`, caption: 'cap', flavor: 'flavor', year: 2020, art: 'brief' })),
      };
      t.writeRegistry([edited]);
      expect(t.run()).toEqual({ status: 0, stdout: '✓ 1 set version(s) OK\n', stderr: '' });
    });
  });

  describe('lock entries', () => {
    it('rejects a set version that is not locked yet, and --update is not run by a plain check', () => {
      const t = makeTree([set('alpha')]);
      const r = t.run();
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(errorLines(r.stderr)).toEqual(['✗ alpha@1 is not locked yet. Run: npm run check:sets -- --update']);
      expect(t.readLockText()).toBeUndefined();
    });

    it('rejects a new version when only the older one is locked', () => {
      const t = makeTree([set('alpha')]);
      t.lock();
      const sets = [set('alpha'), set('alpha', { version: 2 })];
      t.writeRegistry(sets);
      t.addAssets(sets[1], { art: 'png' });
      const r = t.run();
      expect(r.status).toBe(1);
      expect(errorLines(r.stderr)).toEqual(['✗ alpha@2 is not locked yet. Run: npm run check:sets -- --update']);
    });

    const base = set('alpha');
    const changes: [string, SetDefinition][] = [
      ['pack size', { ...base, packSize: 4 }],
      ['odds', { ...base, odds: { ...base.odds, COMMON: 4999, UNCOMMON: 2501 } }],
      ['holo odds', { ...base, holoOdds: 501 }],
      ['modifiers added', { ...base, modifiers: 1 }],
      ['a card rarity', { ...base, cards: [base.cards[0], { ...base.cards[1], rarity: 'EPIC' }, base.cards[2]] }],
      ['card order', { ...base, cards: [base.cards[1], base.cards[0], base.cards[2]] }],
      ['a card id', { ...base, cards: [{ ...base.cards[0], id: 'alpha-z' }, base.cards[1], base.cards[2]] }],
      ['a card added', { ...base, cards: [...base.cards, card('alpha-d')] }],
      ['a card removed', { ...base, cards: base.cards.slice(0, 2) }],
    ];
    it.each(changes)('rejects a locked version whose %s changed', (_label, changed) => {
      const t = makeTree([base]);
      t.lock();
      const lockText = t.readLockText();

      t.writeRegistry([changed]);
      t.addAssets(changed, { art: 'png' });
      const r = t.run();
      expect(r.status).toBe(1);
      expect(errorLines(r.stderr)).toEqual([
        '✗ alpha@1 changed after release (cards, order, rarities, odds, modifiers or pack size). Bump its version instead; old proofs depend on it.',
      ]);
      expect(t.readLockText()).toBe(lockText);
    });

    it('never overwrites a changed hash, even with --update', () => {
      const t = makeTree([base]);
      t.lock();
      const lockText = t.readLockText();

      t.writeRegistry([{ ...base, packSize: 9 }]);
      const r = t.run('--update');
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(errorLines(r.stderr)).toEqual([
        '✗ alpha@1 changed after release (cards, order, rarities, odds, modifiers or pack size). Bump its version instead; old proofs depend on it.',
      ]);
      expect(t.readLockText()).toBe(lockText);
    });

    it('rejects a lock entry whose set version left the registry', () => {
      const t = makeTree([set('alpha'), set('beta')]);
      t.lock();

      t.writeRegistry([set('alpha')]);
      const r = t.run();
      expect(r.status).toBe(1);
      expect(errorLines(r.stderr)).toEqual(['✗ beta@1 is locked but missing from the registry; old proofs need it.']);
    });

    it('rejects a lock entry for a version that was never in the registry, even with --update', () => {
      const t = makeTree([set('alpha')]);
      t.lock();
      const lock = JSON.parse(t.readLockText()!) as Record<string, string>;
      t.writeLock({ ...lock, 'ghost@3': 'f'.repeat(64) });
      const before = t.readLockText();

      const r = t.run('--update');
      expect(r.status).toBe(1);
      expect(errorLines(r.stderr)).toEqual(['✗ ghost@3 is locked but missing from the registry; old proofs need it.']);
      expect(t.readLockText()).toBe(before);
    });
  });

  describe('built images', () => {
    const lockedTree = (s: SetDefinition, assets: (t: Tree) => void) => {
      const t = makeTree([s], { assets: false });
      assets(t);
      t.lock();
      return t;
    };

    it('requires the pack wrapper and the pack thumbnail of a released set', () => {
      const s = set('alpha');
      const t = lockedTree(s, (tree) => tree.addAssets(s, { wrapper: false, art: 'png' }));
      const r = t.run();
      expect(r.status).toBe(1);
      expect(errorLines(r.stderr)).toEqual([
        '✗ alpha@1: no pack wrapper. Run: npm run cards',
        '✗ alpha@1: no pack thumbnail for the pack picker. Run: npm run cards',
      ]);
    });

    it('names the missing one when only the wrapper or only the thumbnail is there', () => {
      const s = set('alpha');
      const t = lockedTree(s, (tree) => tree.addAssets(s, { art: 'png' }));
      rmSync(path.join(t.setsDir, 'alpha/pack.webp'));
      expect(errorLines(t.run().stderr)).toEqual(['✗ alpha@1: no pack wrapper. Run: npm run cards']);

      writeFileSync(path.join(t.setsDir, 'alpha/pack.webp'), '');
      rmSync(path.join(t.setsDir, 'alpha/pack-thumb.webp'));
      expect(errorLines(t.run().stderr)).toEqual(['✗ alpha@1: no pack thumbnail for the pack picker. Run: npm run cards']);
    });

    it('does not ask a draft or an archived set for pack images', () => {
      const draft = set('drafty', { draft: true });
      const old = set('oldie', { archivedAt: '2026-06-01' });
      const t = makeTree([draft, old], { assets: false });
      t.addAssets(draft, { wrapper: false });
      t.addAssets(old, { wrapper: false, art: 'png' });
      t.lock();
      expect(t.run()).toEqual({ status: 0, stdout: '✓ 2 set version(s) OK\n', stderr: '' });
    });

    it('names every card that has no built image, in card order', () => {
      const s = set('alpha');
      const t = lockedTree(s, (tree) => tree.addAssets(s, { art: 'png' }));
      rmSync(path.join(t.setsDir, 'alpha/cards/alpha-c.webp'));
      rmSync(path.join(t.setsDir, 'alpha/cards/alpha-a.webp'));
      const r = t.run();
      expect(r.status).toBe(1);
      expect(errorLines(r.stderr)).toEqual([
        '✗ alpha@1: no built image for "alpha-a". Run: npm run cards',
        '✗ alpha@1: no built image for "alpha-c". Run: npm run cards',
      ]);
    });

    it('still wants every card image from a draft or an archived set', () => {
      const draft = set('drafty', { draft: true });
      const old = set('oldie', { archivedAt: '2026-06-01' });
      const t = makeTree([draft, old], { assets: false });
      t.addAssets(draft, { wrapper: false });
      t.addAssets(old, { wrapper: false });
      rmSync(path.join(t.setsDir, 'drafty/cards/drafty-b.webp'));
      rmSync(path.join(t.setsDir, 'oldie/cards/oldie-a.webp'));
      t.lock();
      const r = t.run();
      expect(r.status).toBe(1);
      expect(errorLines(r.stderr)).toEqual([
        '✗ drafty@1: no built image for "drafty-b". Run: npm run cards',
        '✗ oldie@1: no built image for "oldie-a". Run: npm run cards',
      ]);
    });

    it('looks for images in the folder of each set id, not of another set', () => {
      const a = set('alpha');
      const b = set('beta', { cards: a.cards });
      const t = makeTree([a, b], { assets: false });
      t.addAssets(a, { art: 'png' });
      t.lock();
      const r = t.run();
      expect(r.status).toBe(1);
      expect(errorLines(r.stderr)).toEqual([
        '✗ beta@1: no pack wrapper. Run: npm run cards',
        '✗ beta@1: no pack thumbnail for the pack picker. Run: npm run cards',
        '✗ beta@1: no built image for "alpha-a". Run: npm run cards',
        '✗ beta@1: no built image for "alpha-b". Run: npm run cards',
        '✗ beta@1: no built image for "alpha-c". Run: npm run cards',
      ]);
    });
  });

  describe('placeholder art', () => {
    const svgError = (key: string, id: string) =>
      `✗ ${key}: "${id}" still has placeholder SVG art; released sets need the real image (or swap the card).`;

    it('rejects a released set whose cards still have SVG art', () => {
      const s = set('alpha');
      const t = makeTree([s], { assets: false });
      t.addAssets(s, { art: 'svg' });
      t.lock();
      const r = t.run();
      expect(r.status).toBe(1);
      expect(errorLines(r.stderr)).toEqual([svgError('alpha@1', 'alpha-a'), svgError('alpha@1', 'alpha-b'), svgError('alpha@1', 'alpha-c')]);
    });

    it('rejects an archived set with SVG art too, since only drafts are exempt', () => {
      const s = set('oldie', { archivedAt: '2026-06-01' });
      const t = makeTree([s], { assets: false });
      t.addAssets(s, { wrapper: false, art: 'svg' });
      t.lock();
      expect(errorLines(t.run().stderr)).toEqual([svgError('oldie@1', 'oldie-a'), svgError('oldie@1', 'oldie-b'), svgError('oldie@1', 'oldie-c')]);
    });

    it('allows SVG art in a draft set', () => {
      const s = set('drafty', { draft: true });
      const t = makeTree([s], { assets: false });
      t.addAssets(s, { wrapper: false, art: 'svg' });
      t.lock();
      expect(t.run()).toEqual({ status: 0, stdout: '✓ 1 set version(s) OK\n', stderr: '' });
    });

    it.each(['png', 'card.png'] as const)('accepts real %s art in a released set', (kind) => {
      const s = set('alpha');
      const t = makeTree([s], { assets: false });
      t.addAssets(s, { art: kind });
      t.lock();
      expect(t.run()).toEqual({ status: 0, stdout: '✓ 1 set version(s) OK\n', stderr: '' });
    });

    it('accepts a released card with no art file when its image is built', () => {
      const s = set('alpha');
      const t = makeTree([s], { assets: false });
      t.addAssets(s);
      t.lock();
      expect(t.run()).toEqual({ status: 0, stdout: '✓ 1 set version(s) OK\n', stderr: '' });
    });

    it('flags only the cards that are still SVG', () => {
      const s = set('alpha');
      const t = makeTree([s], { assets: false });
      t.addAssets(s, { art: 'png' });
      rmSync(path.join(t.setsDir, 'alpha/art/alpha-b.png'));
      writeFileSync(path.join(t.setsDir, 'alpha/art/alpha-b.svg'), '');
      t.lock();
      expect(errorLines(t.run().stderr)).toEqual([svgError('alpha@1', 'alpha-b')]);
    });
  });

  describe('reporting', () => {
    it('lists every problem at once, in registry order, and exits 1', () => {
      const alpha = set('alpha');
      const beta = set('beta');
      const t = makeTree([alpha, beta], { assets: false });
      t.addAssets(alpha, { art: 'png' });
      t.addAssets(beta, { wrapper: false, art: 'svg' });
      rmSync(path.join(t.setsDir, 'alpha/cards/alpha-b.webp'));
      t.writeLock({ 'alpha@1': 'a'.repeat(64), 'gone@2': 'b'.repeat(64) });

      const r = t.run();
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(errorLines(r.stderr)).toEqual([
        '✗ alpha@1 changed after release (cards, order, rarities, odds, modifiers or pack size). Bump its version instead; old proofs depend on it.',
        '✗ alpha@1: no built image for "alpha-b". Run: npm run cards',
        '✗ beta@1 is not locked yet. Run: npm run check:sets -- --update',
        '✗ beta@1: no pack wrapper. Run: npm run cards',
        '✗ beta@1: no pack thumbnail for the pack picker. Run: npm run cards',
        '✗ beta@1: "beta-a" still has placeholder SVG art; released sets need the real image (or swap the card).',
        '✗ beta@1: "beta-b" still has placeholder SVG art; released sets need the real image (or swap the card).',
        '✗ beta@1: "beta-c" still has placeholder SVG art; released sets need the real image (or swap the card).',
        '✗ gone@2 is locked but missing from the registry; old proofs need it.',
      ]);
    });

    it('treats an empty lock file entry as not locked', () => {
      const t = makeTree([set('alpha')]);
      t.writeLock({ 'alpha@1': '' });
      expect(errorLines(t.run().stderr)).toEqual(['✗ alpha@1 is not locked yet. Run: npm run check:sets -- --update']);
    });
  });
});
