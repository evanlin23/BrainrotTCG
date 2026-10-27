import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BROWSER_DIR, BURN_IN_BUDGET, MAX_REPEATS, MIN_REPEATS, importsHelper, planBurnIn, repeatsFor } from './burn-in-plan';

const specs = new Map([
  ['tests/browser/network-guard.spec.ts', "import { monitor } from './support';\n"],
  ['tests/browser/a11y-states.spec.ts', "import { test } from '@playwright/test';\nimport { monitor, snapshot } from \"./support.ts\";\n"],
  ['tests/browser/plain.spec.ts', "import { test } from '@playwright/test';\n"],
]);

describe('burn-in plan', () => {
  it('burns in specs the branch adds or changes, but not deleted or non-browser ones', () => {
    expect(planBurnIn(['tests/browser/plain.spec.ts', 'tests/browser/gone.spec.ts', 'src/App.tsx', 'tests/unit/x.spec.ts'], specs)).toEqual({
      specs: ['tests/browser/plain.spec.ts'],
      repeat: MAX_REPEATS,
    });
  });

  it('burns in every spec that imports a changed helper', () => {
    expect(planBurnIn(['tests/browser/support.ts'], specs).specs).toEqual(['tests/browser/a11y-states.spec.ts', 'tests/browser/network-guard.spec.ts']);
    expect(importsHelper("import { a } from './supporting';", 'tests/browser/support.ts')).toBe(false);
  });

  it('burns in specs that import a helper indirectly through other helpers', () => {
    const helperMap = new Map([
      ['tests/browser/base.ts', 'export const BASE = 1;\n'],
      ['tests/browser/mid.ts', "import { BASE } from './base';\nexport const MID = BASE + 1;\n"],
    ]);
    const specMap = new Map([
      ['tests/browser/leaf.spec.ts', "import { MID } from './mid';\n"],
      ['tests/browser/direct.spec.ts', "import { BASE } from './base';\n"],
      ['tests/browser/unrelated.spec.ts', "import { test } from '@playwright/test';\n"],
    ]);
    const plan = planBurnIn(['tests/browser/base.ts'], specMap, helperMap);
    expect(plan.specs).toEqual(['tests/browser/direct.spec.ts', 'tests/browser/leaf.spec.ts']);
  });

  it('terminates circular helper dependencies without looping', () => {
    const helperMap = new Map([
      ['tests/browser/a.ts', "import { b } from './b';\nexport const a = 1;\n"],
      ['tests/browser/b.ts', "import { a } from './a';\nexport const b = 2;\n"],
    ]);
    const specMap = new Map([
      ['tests/browser/cycle-consumer.spec.ts', "import { a } from './a';\n"],
    ]);
    const plan = planBurnIn(['tests/browser/b.ts'], specMap, helperMap);
    expect(plan.specs).toEqual(['tests/browser/cycle-consumer.spec.ts']);
  });

  it('deduplicates diamond helper dependencies and preserves sorted order', () => {
    const helperMap = new Map([
      ['tests/browser/root.ts', 'export const ROOT = 0;\n'],
      ['tests/browser/left.ts', "import { ROOT } from './root';\n"],
      ['tests/browser/right.ts', "import { ROOT } from './root';\n"],
    ]);
    const specMap = new Map([
      ['tests/browser/diamond.spec.ts', "import { left } from './left';\nimport { right } from './right';\n"],
      ['tests/browser/left-only.spec.ts', "import { left } from './left';\n"],
    ]);
    const plan = planBurnIn(['tests/browser/root.ts'], specMap, helperMap);
    expect(plan.specs).toEqual(['tests/browser/diamond.spec.ts', 'tests/browser/left-only.spec.ts']);
  });

  it('excludes unrelated helpers and untouched specs', () => {
    const helperMap = new Map([
      ['tests/browser/used.ts', 'export const USED = 1;\n'],
      ['tests/browser/unused.ts', 'export const UNUSED = 2;\n'],
    ]);
    const specMap = new Map([
      ['tests/browser/consumer.spec.ts', "import { USED } from './used';\n"],
    ]);
    expect(planBurnIn(['tests/browser/unused.ts'], specMap, helperMap).specs).toEqual([]);
  });

  it('supports passing combined sources in a single map', () => {
    const combined = new Map([
      ['tests/browser/base.ts', 'export const BASE = 1;\n'],
      ['tests/browser/mid.ts', "import { BASE } from './base';\n"],
      ['tests/browser/consumer.spec.ts', "import { MID } from './mid';\n"],
    ]);
    const plan = planBurnIn(['tests/browser/base.ts'], combined);
    expect(plan.specs).toEqual(['tests/browser/consumer.spec.ts']);
  });

  it('includes transitive consumers in the real tests/browser stagingAccess -> support -> specs chain', () => {
    const browserFiles = readdirSync(BROWSER_DIR).map((name) => `${BROWSER_DIR}/${name}`);
    const realSpecs = new Map(
      browserFiles.filter((file) => file.endsWith('.spec.ts')).map((file) => [file, readFileSync(file, 'utf8')]),
    );
    const realHelpers = new Map(
      browserFiles.filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts')).map((file) => [file, readFileSync(file, 'utf8')]),
    );

    const plan = planBurnIn(['tests/browser/stagingAccess.ts'], realSpecs, realHelpers);

    // Direct consumers of stagingAccess:
    expect(plan.specs).toContain('tests/browser/staging-access.spec.ts');
    expect(plan.specs).toContain('tests/browser/built-site.spec.ts');

    // Indirect consumers through support.ts (which imports stagingAccess):
    expect(plan.specs).toContain('tests/browser/network-guard.spec.ts');
    expect(plan.specs).toContain('tests/browser/a11y-states.spec.ts');

    // The whole chain covers support.ts consumers:
    expect(plan.specs.length).toBeGreaterThanOrEqual(65);
    expect(plan.repeat).toBe(repeatsFor(plan.specs.length));
  });

  it('burns in nothing for config or app changes alone', () => {
    expect(planBurnIn(['playwright.config.ts', 'src/components/cards/CardViewerModal.tsx'], specs)).toEqual({ specs: [], repeat: 0 });
  });

  it('shrinks repeats as the list grows, but never below the minimum', () => {
    expect(repeatsFor(1)).toBe(MAX_REPEATS);
    expect(repeatsFor(BURN_IN_BUDGET / 4)).toBe(4);
    expect(repeatsFor(26)).toBe(MIN_REPEATS);
    expect(repeatsFor(500)).toBe(MIN_REPEATS);
  });
});
