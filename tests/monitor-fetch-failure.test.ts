import { describe, expect, it } from 'vitest';
import { fetchFailureReason } from './browser/support';

// What route.fetch throws when the server drops the connection (Playwright 1.64): a call log that
// repeats the full URL and every request header, a staging Access token included.
const dropped = new Error(`route.fetch: socket hang up (ECONNRESET)
Call log:
  - → GET https://staging.brainrottcg.pages.dev/assets/app.js?run=1-1
    - user-agent: Mozilla/5.0
    - cf-access-client-id: id.access
    - cf-access-client-secret: not-for-logs`);

describe('fetchFailureReason', () => {
  it("keeps the reason's first line, not the call log with the URL and headers", () => {
    const reason = fetchFailureReason(dropped, ['id.access', 'not-for-logs']);
    expect(reason).toBe('socket hang up (ECONNRESET)');
  });

  it('sanitizes URLs and redacts the secrets in the first line too', () => {
    const error = new Error('route.fetch: getaddrinfo ENOTFOUND https://staging.brainrottcg.pages.dev/x?key=not-for-logs (not-for-logs)');
    expect(fetchFailureReason(error, ['id.access', 'not-for-logs'])).toBe('getaddrinfo ENOTFOUND https://staging.brainrottcg.pages.dev/x ([redacted])');
  });

  it('bounds the reason, and says when there is none', () => {
    expect(fetchFailureReason(new Error(`route.fetch: ${'x'.repeat(500)}`), [])).toHaveLength(200);
    expect(fetchFailureReason(new Error(''), [])).toBe('no reason given');
    expect(fetchFailureReason('timed out', [''])).toBe('timed out');
  });
});
