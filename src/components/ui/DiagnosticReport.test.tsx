// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordDiagnostic, setBrowserDiagnosticCapture } from '../../game/diagnostics';
import DiagnosticReport from './DiagnosticReport';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setBrowserDiagnosticCapture(false);
  vi.unstubAllGlobals();
});

const textarea = () => document.querySelector('textarea')!;
const button = (name: string) => [...document.querySelectorAll('button')].find((node) => node.textContent === name)!;
const edit = (text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), text);
  textarea().dispatchEvent(new Event('input', { bubbles: true }));
});
const open = () => act(() => root.render(<DiagnosticReport onClose={() => {}} />));
const status = () => document.querySelector('[role="status"]')!.textContent;

describe('Clear recorded steps', () => {
  beforeEach(() => {
    setBrowserDiagnosticCapture(true);
    recordDiagnostic('pack-open');
  });

  it('empties the steps in the text, and keeps what the player edited around them', () => {
    open();
    const report = JSON.parse(textarea().value) as Record<string, unknown>;
    expect(report.events).toEqual([{ step: 1, event: 'pack-open' }]);
    edit(JSON.stringify({ ...report, whatIWasDoing: 'opening a pack' }));

    act(() => button('Clear recorded steps').click());

    const after = JSON.parse(textarea().value) as Record<string, unknown>;
    expect(after.events).toEqual([]);
    expect(after.whatIWasDoing).toBe('opening a pack');
    expect(status()).toContain('from your edited text');
  });

  it('says so when an edit moved a step elsewhere in the text, where clearing does not reach', () => {
    open();
    const report = JSON.parse(textarea().value) as Record<string, unknown>;
    edit(JSON.stringify({ ...report, copied: [{ step: 1, event: 'pack-open' }] }));

    act(() => button('Clear recorded steps').click());

    const after = JSON.parse(textarea().value) as Record<string, unknown>;
    expect(after.events).toEqual([]);
    expect(after.copied).toEqual([{ step: 1, event: 'pack-open' }]);
    expect(status()).toBe('Recorded steps cleared from this tab. Your edits were kept, and steps you moved elsewhere in the text are still in it.');
  });

  it('keeps edited text that is no longer report JSON, and says its steps were not removed', () => {
    open();
    edit('Reviewed report');
    act(() => button('Clear recorded steps').click());
    expect(textarea().value).toBe('Reviewed report');
    expect(status()).toContain('no longer valid report JSON');
  });

  it('makes a new report when the text was never edited', () => {
    open();
    act(() => button('Clear recorded steps').click());
    expect((JSON.parse(textarea().value) as { events: unknown[] }).events).toEqual([]);
    expect(status()).toBe('Recorded steps cleared from this tab.');
  });
});
