import { describe, expect, it } from 'vitest';
import { clean, isBasePath, parseOptions, parseOutcome } from './contracts';

describe('local audit evidence contracts', () => {
  it('supports root and prefixed hosting while refusing URL/path escapes', () => {
    expect(isBasePath('/')).toBe(true);
    expect(isBasePath('/BrainrotTCG/')).toBe(true);
    for (const value of ['//', '/../../', 'https://example.com/', '/no-trailing-slash']) expect(isBasePath(value)).toBe(false);
  });
  it('bounds sequential tasks/time and rejects unknown and duplicate requests', () => {
    expect(parseOptions([])).toEqual({ selected: ['opening'], seconds: 90 });
    expect(parseOptions(['--task=opening', '--task=results', '--seconds=180']).selected).toHaveLength(2);
    for (const args of [['--task=constructor'], ['--task=opening', '--task=opening'], ['--seconds=999'], ['--parallel=20']]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });
  it('does not accept an agent success with no browser evidence', () => {
    const raw = JSON.stringify({ outcome: 'completed', observations: 'Done' });
    expect(() => parseOutcome(raw, [])).toThrow('No browser evidence');
    expect(parseOutcome(raw, ['snapshot: visible accessibility tree', 'click: visible control']).outcome).toBe('completed');
    expect(() => parseOutcome('{', [])).toThrow();
    expect(() => parseOutcome(JSON.stringify({ outcome: 'success' }), [])).toThrow();
  });
  it('bounds and removes URLs, opaque keys, emails and controls from retained prose', () => {
    const text = clean('https://example.com/?secret=oops hi@example.com ' + '01'.repeat(32) + '\n' + 'a'.repeat(2000));
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).not.toContain('secret=oops');
    expect(text).not.toContain('hi@example');
    expect(text).not.toContain('010101');
    expect(text).not.toContain('\n');
  });
});
