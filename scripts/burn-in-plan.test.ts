import { describe, expect, it } from 'vitest';
import { BURN_IN_BUDGET, MAX_REPEATS, MIN_REPEATS, importsHelper, planBurnIn, repeatsFor } from './burn-in-plan';

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
