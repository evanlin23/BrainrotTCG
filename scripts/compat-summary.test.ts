import { describe, expect, it } from 'vitest';
import { compatSummary } from './compat-summary';

describe('compatSummary', () => {
  it('lists each project with its engine version and every outcome count', () => {
    const text = compatSummary([
      { name: 'desktop-firefox', engine: 'firefox', version: '157.0', passed: 3, failed: 0, skipped: 0, flaky: 0 },
      { name: 'mobile-webkit', engine: 'webkit', version: '26.4', passed: 2, failed: 1, skipped: 0, flaky: 0 },
    ]);
    expect(text).toContain('| desktop-firefox | firefox 157.0 | 3 | 0 | 0 | 0 |');
    expect(text).toContain('| mobile-webkit | webkit 26.4 | 2 | 1 | 0 | 0 |');
  });

  it('says what the run is not evidence for', () => {
    expect(compatSummary([])).toMatch(/not iOS Safari, a physical phone or its native share sheet/);
  });
});
