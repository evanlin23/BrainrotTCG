# Readiness without an application server

Draft for Claude review. This completes ownership/design for the remaining readiness gaps; it does not implement them or authorize a merge/deployment. Static hosting, browser storage/workers, repository CI and existing relay/intake services are sufficient. Those external services have limits and delays; “no app server” does not mean “no services” or unlimited free capacity.

## Work and owners

| Deliverable | Implementation approach | Completion evidence |
| --- | --- | --- |
| Release/rollback | Versioned static artifact and a reviewer checklist; same-origin rollback with save-schema compatibility verified | Tested recovery plan, approved release evidence, preserved old proof links |
| Player diagnostics | Allowlisted bounded local diagnostics, explicit preview/copy and report link; no telemetry backend | Secret-injection tests, recoverable error UI, no automatic data transmission |
| Asset integrity | Registry-derived build checks and decode validation plus base-path browser smoke | Missing/corrupt fixtures fail; required built assets decode |
| Storage longevity (#87/#181) | Visible persistence status, safe replacement, private export/recovery, measured long-history behavior | Quota/import/concurrency tests and recoverable save failure |
| Submission capacity (#225/#234) | Fake-service sustained-load and outage experiments, existing intake budgets, bounded candidates and evidence | Recorded backlog/retry/verification behavior; no public-relay stress testing |
| Actual player/phone validation (#211/#8/#12) | Uncoached sessions, Android/iPhone and accessibility observations | Recorded participants/test conditions and resolved or explicitly accepted blockers |

## Release gate and rollback

Save loss, failed historical proof verification, persistent blank-screen/asset failures, and inaccessible primary controls block promotion. Record commit/build identity, check/build/independent-verifier results and relevant TESTING.md scenarios. Name the reviewer and list unrun manual checks. A draft or green unit suite does not establish readiness.

Keep the previous known-good static artifact or reproducible commit. Before rollback, test whether it can read saves written by the newer release; if not, use a compatible reader/forward fix rather than erase or overwrite player data. Retain historical set definitions. Ranking snapshots and moderation evidence have their own versions and should not be blindly replaced with an old app artifact.

Prefer same-origin rollback. Switching between Cloudflare and GitHub changes storage origin; deleting hosting secrets can strand progress and is not a general recovery plan. Any domain move needs explicit migration/recovery validation. A post-release read-only smoke verifies expected build identity, asset routes, valid proof and invalid-proof recovery. No release is performed under the current Claude review hold.

## Diagnostics and local storage

Diagnostics use an allowlist: build id, route category, dimensions, coarse browser/network category and sanitized error codes/action steps. Exclude secret keys, saves, storage dumps, proof/hash/query payloads, raw URLs and arbitrary exception text. Keep a small bounded memory buffer; the player previews and explicitly copies a report. A report link has no diagnostic payload in its query. No background upload or added tracking.

A crash boundary should provide recovery/help without promising unavailable exports or clearing saves. Explain durable save failure versus session-only play. Optional browser persistent-storage requests cannot protect against explicit site-data clearing. Private backup files restore identity/progress; public proof links do not. Test quota and long-history costs before choosing retention or a browser database migration; changing storage technology alone does not solve deletion or cross-device recovery. Accounts remain deferred.

## Assets and intake

Asset checks enumerate actual registered variants and required generated outputs, not a second handwritten catalog. Decode card/finish/pack/preview images, validate dimensions, and test both host base configurations. This is build validation, not a proposal to preload all art. Cache invalidation must cover source/mask/compositor inputs.

Capacity tests use deterministic fixtures and fake relay/GitHub adapters, including sustained producers, duplicates, outages, backlog recovery and budget exhaustion. Do not load-test public relays. Measure expected work/retention before enabling automatic submission broadly. Client queues and throttles are optimizations, not enforcement against external miners; intake independently bounds verification. Surface update time and pending status rather than promising instant rankings.

## Deferred or externally dependent

No account service, cloud save recovery, spending/trading ledger, opening-time attestation, or GPU fairness guarantee is added. Social publication still needs accounts/provider authorization and supported APIs. Real-phone/accessibility/newcomer evidence requires people and devices even though it requires no server. Implementation, device verification and deployment remain distinct from this planning work.

Implementation owners: #235 release/rollback, #236 local diagnostics, #237 asset integrity. Existing #87/#181/#225/#234/#211/#8/#12 retain the related scopes above.

Independent subagent task audits and phone/browser emulation are part of TESTING.md’s repeatable verification flow. They provide task/error evidence and issue triage without a server; they do not complete human-participant or physical-device acceptance criteria.
