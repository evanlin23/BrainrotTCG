import { afterEach, describe, expect, it } from 'vitest';
import { clearDiagnostics, diagnosticSnapshot, isDiagnosticCaptureEnabled, observeDiagnosticEvents, recordDiagnostic, setDiagnosticCapture, type DiagnosticEvent } from './diagnostics';

afterEach(() => setDiagnosticCapture(false));

describe('allowlisted optional diagnostics', () => {
  it('starts disabled, drops unknown events and caps the session buffer', () => {
    recordDiagnostic('pack-open');
    expect(diagnosticSnapshot({}).events).toEqual([]);
    setDiagnosticCapture(true);
    for (let n = 0; n < 100; n++) recordDiagnostic('pack-open');
    recordDiagnostic('secret=player-key' as DiagnosticEvent);
    expect(diagnosticSnapshot({}).events).toHaveLength(32);
    expect(diagnosticSnapshot({}).events[0].step).toBe(69);
    setDiagnosticCapture(false);
    expect(isDiagnosticCaptureEnabled()).toBe(false);
    expect(diagnosticSnapshot({}).events).toEqual([]);
  });

  it('returns copies and clears without preserving a tracking identifier', () => {
    setDiagnosticCapture(true);
    recordDiagnostic('pack-open');
    diagnosticSnapshot({}).events[0].event = 'copy-failed';
    expect(diagnosticSnapshot({}).events[0].event).toBe('pack-open');
    clearDiagnostics();
    recordDiagnostic('view-cards');
    expect(diagnosticSnapshot({}).events).toEqual([{ step: 1, event: 'view-cards' }]);
  });

  it('never echoes injected secrets, proof hashes, URLs, user agents or unknown fields', () => {
    const secret = 'PRIVATE_KEY_AND_SIGNED_PROFILE_DO_NOT_COPY';
    const environment = {
      userAgent: `Mozilla Chrome/999 ${secret}`, hash: `#/pull/${secret}?token=${secret}`,
      revision: secret, effectiveType: secret, url: `https://example.invalid/${secret}`,
      localStorage: { secretKey: secret }, error: new Error(secret), cookie: secret,
    };
    const snapshot = diagnosticSnapshot(environment);
    expect(snapshot.browser).toBe('chromium');
    expect(snapshot.route).toBe('shared-pull');
    expect(snapshot.build).toBe('unknown');
    expect(snapshot.connection).toBe('unknown');
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(Object.keys(snapshot)).toEqual(['format', 'build', 'browser', 'device', 'route', 'viewport', 'connectivity', 'connection', 'captureEnabled', 'events']);
  });

  it.each([
    ['Firefox/100 Android', '#/profile/private', 'firefox', 'android', 'shared-profile'],
    ['Safari/600 iPhone', '', 'safari', 'ios', 'opening'],
    ['Edg/100 Chrome/100', '#private', 'edge', 'other', 'other'],
    ['Chrome/100', '#/cards', 'chromium', 'other', 'cards'],
    ['Chrome/100', '#/rankings', 'chromium', 'other', 'rankings'],
    ['Chrome/100', '#/profile', 'chromium', 'other', 'profile'],
    ['Chrome/100', '#/settings', 'chromium', 'other', 'settings'],
    ['Chrome/100', '#/profile/', 'chromium', 'other', 'shared-profile'],
    ['Chrome/100', '#/cards/private', 'chromium', 'other', 'other'],
  ])('reduces browser and route to known categories: %s', (userAgent, hash, browser, device, route) => {
    expect(diagnosticSnapshot({ userAgent, hash })).toMatchObject({ browser, device, route });
  });

  it('bounds numeric fields and accepts only a public revision shape', () => {
    expect(diagnosticSnapshot({ width: Infinity, height: -20, revision: 'a'.repeat(40), online: false })).toMatchObject({
      viewport: { width: 0, height: 0 }, build: 'a'.repeat(12), connectivity: 'offline',
    });
    expect(diagnosticSnapshot({ width: 1e9, height: 500.4 }).viewport).toEqual({ width: 16384, height: 500 });
    expect(diagnosticSnapshot({ revision: 'a'.repeat(64) }).build).toBe('unknown');
  });

  it('discards error payloads and disposes its exact listeners', () => {
    const target = new EventTarget() as Window;
    setDiagnosticCapture(true);
    const stop = observeDiagnosticEvents(target);
    const error = new Event('error');
    Object.assign(error, { message: 'PRIVATE_SAVE', error: new Error('PRIVATE_SAVE') });
    target.dispatchEvent(error);
    target.dispatchEvent(new Event('hashchange'));
    stop();
    target.dispatchEvent(error);
    expect(diagnosticSnapshot({}).events).toEqual([{ step: 1, event: 'unhandled-error' }, { step: 2, event: 'route-change' }]);
    expect(JSON.stringify(diagnosticSnapshot({}))).not.toContain('PRIVATE_SAVE');
  });

  it('records unhandled rejections without their reason, and stops on teardown', () => {
    const target = new EventTarget() as Window;
    setDiagnosticCapture(true);
    const stop = observeDiagnosticEvents(target);
    const rejection = Object.assign(new Event('unhandledrejection'), { reason: new Error('PRIVATE_SAVE') });
    target.dispatchEvent(rejection);
    stop();
    target.dispatchEvent(rejection);
    expect(diagnosticSnapshot({}).events).toEqual([{ step: 1, event: 'unhandled-error' }]);
    expect(JSON.stringify(diagnosticSnapshot({}))).not.toContain('PRIVATE_SAVE');
  });

  it.each([
    ['slow-2g', 'slow'], ['2g', 'slow'], ['3g', 'medium'], ['4g', 'fast'], ['5g', 'unknown'], [undefined, 'unknown'],
  ])('reduces connection type %s to %s', (effectiveType, connection) => {
    expect(diagnosticSnapshot({ effectiveType }).connection).toBe(connection);
  });
});
