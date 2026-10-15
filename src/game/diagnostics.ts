/** Optional, session-only observations. Raw errors, names, saves and URLs are never accepted. */
const EVENTS = ['pack-open', 'view-cards', 'view-rankings', 'route-change', 'render-error', 'unhandled-error', 'copy-failed'] as const;
export type DiagnosticEvent = typeof EVENTS[number];
const MAX_EVENTS = 32;
let capturing = false;
let sequence = 0;
const events: { step: number; event: DiagnosticEvent }[] = [];

export function setDiagnosticCapture(enabled: boolean) {
  capturing = enabled;
  if (!enabled) clearDiagnostics();
}

export const isDiagnosticCaptureEnabled = () => capturing;
export function clearDiagnostics() { events.length = 0; sequence = 0; }

export function recordDiagnostic(event: DiagnosticEvent) {
  if (!capturing || !EVENTS.includes(event)) return;
  events.push({ step: ++sequence, event });
  if (events.length > MAX_EVENTS) events.shift();
}

interface Environment {
  revision?: string;
  userAgent?: string;
  hash?: string;
  width?: number;
  height?: number;
  online?: boolean;
  effectiveType?: string;
}

const dimension = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(0, Math.min(16384, Math.round(value))) : 0;

export function diagnosticSnapshot(environment: Environment) {
  const ua = typeof environment.userAgent === 'string' ? environment.userAgent.slice(0, 2048) : '';
  const hash = typeof environment.hash === 'string' ? environment.hash : '';
  return {
    format: 1,
    build: typeof environment.revision === 'string' && /^[a-f0-9]{40}$/i.test(environment.revision) ? environment.revision.slice(0, 12) : 'unknown',
    browser: /Firefox\//i.test(ua) ? 'firefox' : /Edg\//i.test(ua) ? 'edge' : /Chrome\//i.test(ua) ? 'chromium' : /Safari\//i.test(ua) ? 'safari' : 'other',
    device: /iPhone|iPad|iPod/i.test(ua) ? 'ios' : /Android/i.test(ua) ? 'android' : 'other',
    route: hash.startsWith('#/pull/') ? 'shared-pull' : hash.startsWith('#/profile/') ? 'shared-profile' : hash ? 'other' : 'opening',
    viewport: { width: dimension(environment.width), height: dimension(environment.height) },
    connectivity: environment.online === true ? 'online' : environment.online === false ? 'offline' : 'unknown',
    connection: environment.effectiveType === 'slow-2g' || environment.effectiveType === '2g' ? 'slow'
      : environment.effectiveType === '3g' ? 'medium' : environment.effectiveType === '4g' ? 'fast' : 'unknown',
    captureEnabled: capturing,
    events: events.map((event) => ({ ...event })),
  };
}

/** Reads only the coarse browser metadata above; no storage, query, proof or error payloads. */
export function browserDiagnostics() {
  return diagnosticSnapshot({
    revision: typeof __BUILD_REVISION__ === 'string' ? __BUILD_REVISION__ : undefined,
    userAgent: navigator.userAgent,
    hash: location.hash,
    width: window.innerWidth,
    height: window.innerHeight,
    online: navigator.onLine,
    effectiveType: (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType,
  });
}

/** Only installed after explicit opt-in. Payloads are deliberately discarded, even in errors. */
export function observeDiagnosticEvents(target: Window) {
  const error = () => recordDiagnostic('unhandled-error');
  const route = () => recordDiagnostic('route-change');
  target.addEventListener('error', error);
  target.addEventListener('unhandledrejection', error);
  target.addEventListener('hashchange', route);
  return () => {
    target.removeEventListener('error', error);
    target.removeEventListener('unhandledrejection', error);
    target.removeEventListener('hashchange', route);
  };
}
