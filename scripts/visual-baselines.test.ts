// The screenshot baselines (#745) mean something only while they are drawn by one pinned browser,
// compared with no tolerance, never written by CI, and few enough to review. These hold the config,
// the workflow, the docs and the committed images to that. Read as text, like scripts/ci-stages.test.ts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const config = read('playwright.visual.config.ts');
const spec = read('tests/visual/screens.spec.ts');
const workflow = read('.github/workflows/browser-tests.yml');
const development = read('docs/DEVELOPMENT.md');
const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version: string }> };
const BASELINES = 'tests/visual/baselines';

const IMAGE = /mcr\.microsoft\.com\/playwright:v([\d.]+)-noble@sha256:[0-9a-f]{64}/g;
// About a dozen screens' worth at scale 1; past this, add fewer screens or crop, not a bigger budget.
const BUDGET_BYTES = 3_000_000;

describe('the visual baselines (#745)', () => {
  it('run in the Playwright image of the locked @playwright/test version, pinned by digest, in CI and in the docs', () => {
    const version = lock.packages['node_modules/@playwright/test'].version;
    const inWorkflow = [...workflow.matchAll(IMAGE)];
    expect(inWorkflow).toHaveLength(1);
    expect(inWorkflow[0][1]).toBe(version);
    expect(workflow).toContain(`    container:\n      image: ${inWorkflow[0][0]}\n`);
    const inDocs = [...development.matchAll(IMAGE)].map((m) => m[0]);
    expect(inDocs.length).toBeGreaterThan(0);
    expect(new Set(inDocs)).toEqual(new Set([inWorkflow[0][0]]));
  });

  it('allow no difference at all', () => {
    expect(config).toMatch(/^\s+threshold: 0,$/m);
    expect(config).toMatch(/^\s+maxDiffPixels: 0,$/m);
    expect(config).not.toMatch(/maxDiffPixelRatio/);
    expect(spec).not.toMatch(/threshold|maxDiffPixel|mask/);
  });

  it('are never written by CI', () => {
    expect(config).toContain("updateSnapshots: process.env.CI ? 'none' : 'missing',");
    expect(workflow).toContain('      - run: npm run test:visual -- --update-snapshots=none\n');
    for (const text of [workflow, read('.github/workflows/ci.yml'), read('package.json')]) {
      expect(text.match(/--update-snapshots(?!=none)|\s-u\b/g)).toBeNull();
    }
  });

  it('are exactly one committed image per screen and project, within budget', () => {
    const screens = [...spec.matchAll(/toHaveScreenshot\('([\w-]+)\.png'\)/g)].map((m) => m[1]);
    const projects = [...config.matchAll(/\{ name: '([\w-]+)'/g)].map((m) => m[1]);
    expect(screens.length).toBeGreaterThan(0);
    expect(projects).toEqual(['narrow', 'desktop']);
    const expected = screens.flatMap((s) => projects.map((p) => `${s}-${p}.png`)).sort();
    const files = readdirSync(new URL(`../${BASELINES}`, import.meta.url)).sort();
    expect(files).toEqual(expected);
    const bytes = files.reduce((sum, f) => sum + statSync(new URL(`../${BASELINES}/${f}`, import.meta.url)).size, 0);
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });
});
