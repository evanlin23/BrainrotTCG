# Current Claude review packet

October 14, 2026. Pending review; expires when this queue is triaged. This is a snapshot, not permanent agent guidance. Use ROADMAP.md/live milestones for sequencing and DEVELOPMENT.md for engineering/testing. Existing user review/merge/deploy/posting restrictions still apply.

## Verified baseline

Main is `b3362bc8cca34ef43aa837590828bce8af710edd`, including merged #311 (retroactive history achievements). Updated #313 reconciles that change in the private candidate below. Drafts are review proposals, not shipped behavior. No physical-device, human newcomer or local agent task-browser audit evidence is available.

Main protection currently requires GitHub Actions `check` and `independent-verifier`, enforced for non-admins. The owner intentionally retains administrator bypass and active automatic deployment. Add browser/workflow requirements after their draft jobs land. Full protection/Actions-policy administration remains API-inaccessible; fork-approval configuration is unverified. #308 records readiness; #316/#353 partially harden automatic deployment. No deployment was dispatched.

## PR reconciliation order

| PR | Review requirement |
| --- | --- |
| #315 contributor foundation | Draft on main. Review concise AGENTS/DEVELOPMENT, issue/PR intake and frozen setup before assigning arbitrary contributor tasks. Remaining protection/policy verification belongs to #308. |
| #347 token efficiency | Restored at `d39d7aa`, stacked on #315 (`ac99024`): four files/17 added lines, exactly the checked `2351ccc` tree. Owner confirms Jules sessions archived; Codex owns the repair. Conflicting bot-authored snapshots were reverted with normal commits; their authorship does not establish ongoing agent activity. Verify final-head CI. Preserve token-efficient sessions, owned preview checks, test exit status and one shared contributor guide. CLI behavior/token-savings measurement remains unrun. |
| #216 docs | Draft, now stacked on #315. Contains roadmap/proposals and this temporary packet; basic contributor guidance no longer requires consuming the whole proposal. |
| #188 usability | Draft, conflicts with main. Preserve main's protected reveals, configurable pauses, cosmetics and short-screen fixes while removing A/auto-open. Latest naming in #183/ROADMAP supersedes this earlier layout. |
| #238 background recovery | Merged into current main, CI passed. Its storage/background follow-ups below remain; memory tests do not prove durability. |
| #203 finishes | Draft based on #188. Restack after reconciliation; preserve historical files/locks/vectors and table-2 restoration/export behavior. Optional, not a prerequisite for reliability fixes. |

The October 13 follow-up reviewed all 119 open issues and the then-open 13 PRs. Ten small drafts (#259/#268/#269/#270/#274/#275/#276/#280/#281/#282) had no identified blocking functional finding. #259 subsequently added the requested test-global cleanup; focused tests pass at `5648cec`. This is scoped review, not combined integration or physical-device evidence. Use live PR reviews for exact heads/checks.

Additional October 14 drafts, independently reviewed with passing local checks and hosted CI:

| PR | Scope and remaining boundary |
| --- | --- |
| #283 | Weekly dependency-update automation only; detailed advisory triage is in #230. Hosted bot execution awaits default-branch integration. |
| #285 | One bounded ticket-pool fallback slot, worker-failure recovery and close rejection; 13 regressions. Nonabortable CPU work may finish after close. |
| #286 | Validate Settings backup/identity before writes; 61 save regressions including legacy exports. Atomic replacement, quota rollback, omitted-field identity/provenance and old-origin import remain #181. |
| #287 | Vite 7.3.1 → 7.3.5 only; five Vite advisory IDs removed, 27 other distinct IDs remain. Preserve Jules #290's Playwright additions when combining lockfiles. |
| #288 | Disabled/reduced-motion sparks do no emission work; timers cancel on transitions/unmount. Local mounted regression passes, maintained browser test and measured phone latency remain pending. Preserve particle-option wiring with #188/#284. |
| #289 | Failed finish thumbnails use full-size finish rendering; mounted error/stale-result cases pass. Combine with #282's nondraggable default; maintained image-failure browser coverage remains pending. |
| #291 | Guard selected-set preference reads/writes; denied storage keeps the app/selection usable. Other storage paths remain #87. |
| #292 | **Merge hold:** filtered recovery view for malformed collection records. Load preserves raw storage, but the next pack write discards unreadable entries. Decide quarantine/backup/export policy before integration; this is not end-to-end data preservation. |
| #293 | Patch only PostCSS/nanoid/source-map-js lock entries; eight advisory IDs removed. Reconcile with #287 and #290's dependency changes. |
| #294 / #356 | Load deadline plus stacked PNG-encoding deadline. #356 at `001dbef` has 136 branch tests, build and independent 8-case review; original stalled encoder fails its regression. Native encoding cancellation, cache budgets, visible retry UI and phones remain #226. |
| #295 / #297 | Pin CI/deployment actions to checked official release commits. Static actionlint passes; ShellCheck unavailable. No deployment dispatched; upload-pages-artifact still calls a mutable nested upload-artifact action. Preserve #275 permissions. |
| #296 | New players start with music off; existing explicit/legacy preferences preserved. Built-browser request/play checks pass; physical audio accessibility remains #12. |
| #298 | **Stack on #286:** failed identity persistence preserves old memory/storage identity. Earlier imported fields can still change without stacked #300; #181 remains open. |
| #299 | Old-origin transfer writes its backup before deletion; failed backup preserves the original save. Complete transfer rollback/validation remains #181. |
| #300 | **Stack on #298:** required backup, identity-last commit and verified best-effort rollback after synchronous write failures. No crash/cross-tab journal or new omitted-field policy. |
| #301 | Release orphaned/version-changing IndexedDB connections; native same-context two-page upgrade/delete regressions pass. Durable-write/resume guarantees remain pending. |
| #302 | **Stack on #284:** rotated spark origins align within 0.08 px in the mounted fixture. Gesture policy unchanged; physical-phone/swipe performance unrun. |
| #304 | **Stack on #290:** owned current-build browser gate, outbound HTTP/WS interception, image decoding and exact five-card/count/modifier/history reload equality. Lost-card/double-award mutations fail; two Chromium emulation projects pass. |
| #305 | Legacy migration keeps source/current raw logs until all eligible ticket mappings persist; forbids migration truncation. New-pack quota retention policy remains #241. |
| #306 | **Stack on #259:** failure differs from empty, accessible deduplicated Retry and retired relay cleanup; fixes reproduced StrictMode verification lifecycle. Active proof work is nonabortable. |
| #310 | **Stack on #288:** one expiry timer/update per spark burst. Controlled mounted input reduces 300 timers to 100, with same density/cap; no FPS/phone claim. |
| #313 | Foreground denied writes keep UI usable and latch one honest warning. Persistence follows committed state; interruption before persistence and pending-ticket durability remain #87/#241. |
| #315 | Independent contributor foundation, schema/link/command checks only; GitHub form rendering and protection enforcement unverified. #216 now inherits this branch. |
| #316 | **Stack on #297:** verification gates build itself, which publishes Cloudflare, plus Pages transitively. Static graph/vector checks pass; no live deploy test. |
| #319 | Pin remaining inbox actions; normalized configuration/permissions unchanged, no live intake/dispatch. |
| #321 | One-file architecture source reconciliation; distinguishes configured services, actual verification/storage limits and file existence from decoding. |
| #322 | **Stack on #270:** decoder joins canonical check, which CI/deploy already run. Actual corrupt existing card fails after existence guard passes; restored bytes/full chain pass. |
| #353 | **Stack on #316:** five-line, case-sensitive source-ref guard before checkout. Independent 11-case review and hosted CI pass; old workflow versions, secret isolation and shared cancellation remain #349. |
| #354 | **Stack on #315:** reusable mounted real-App/Argon opening→record→reload fixture. Node 22 branch check: 132 tests/20 files, 16 locks; build, dropped/double-award mutations and independent focused review pass. No new audit advisory IDs versus its frozen base; browser/IDB/phone evidence remains separate. |
| #357 | **Stack on #304:** cold-cache report-only performance runner, manual read-only Actions job. Author six samples, preserved two-project smoke and 131 branch tests pass; independent report tests, one positive sample and injected collection-loss failure verified. Warm cache/Worker WebSocket boundary remain #351; no physical-phone/deployed-main claim. |

Jules #284 and #290 require their stacked corrections #302/#304, not isolated integration of the original green heads. Original #284 tests passed unchanged production code and mounted rotation drifted 43.47 px; original #290 omitted WS isolation, exact saved cards and owned-server enforcement. Corrective evidence is in the follow-up PRs. Phone viewport emulation still does not establish touch/device performance.

A private, unpublished candidate at `83bf282a16228a90af5d16e5f68b7787d3716fa3` combines 45 draft patches, including #347/#353/#354/#356/#357 and current main's #311. It excludes #188/#203/#216. Frozen npm ci and the final Node 22.23.3 canonical check pass: lint/types, **354 tests/35 files**, 16 released-set locks and 127 decoded base-card images. Both maintained owned-build desktop/Pixel 5 Chromium opening/record/reload journeys pass at this exact head (2/2). Builds use 3,057 cached previews/3,311 pages with the existing chunk warning. Earlier 163 Python vectors/actionlint evidence has unchanged engine/workflow inputs except the separately checked source guard/performance workflow; Python was 3.12 locally versus 3.13 in CI, and ShellCheck was unavailable. No claim that those older commands were rerun on this final head.

Manual reconciliation preserves #282+#289 image behavior; #286+#291+#313 import/selection/persistence wiring; both storage test suites; and #304+#315+#357 browser/contributor/performance README sections. Independent review of #315/#347/#268/#304/#316 and then #353/#354/#356/#357 found no blockers within tested scope. All 48 open PR heads had successful hosted rollups before this documentation refresh; that is not combined integration approval. The private candidate **does not lift #292's raw-data merge hold** or establish save durability, physical-device/newcomer outcomes, native sharing, Claude CLI behavior or complete production credential isolation. Rebuild/recheck after final integration. Audit findings remain #230; #354 adds no new advisory IDs relative to its base.

Fix independent blockers without waiting for optional finishes. Old green checks do not validate the final combined head.

#203 also needs main's shared `frameRecolor.ts` extended: its older inline renderer bypasses that newer boundary. A targeted check of the exact main helper with #203 types produces missing-finish type errors and runtime failures for Neon/Cosmic/Ember. Preserve thumbnail rendering, use actual image width and generate/decode supported thumbnails before activation (#187/#237); preserve historical finish ordering. This check is not a completed merged-app build.

PR #238 checks, owned by #87/#181/#229/#233/#73/#235:

- Resume flag clears before final IndexedDB batch; swallowed transaction failures can report completion with memory-only data. Test durable reload/resume and visible failure.
- Whole-store startup hydration and all-spare-worker reconstruction need latency/memory/foreground budgets.
- Profile stats refresh but memoized history may remain stale; test pack rows/sharing after reconstruction.
- Use real browser IndexedDB/Workers for blocked/open/versionchange/quota/abort, key changes, interrupted batches and cross-tab behavior.
- Export/origin transfer omits IndexedDB: cache is discardable only if original ticket/set/version provenance reconstructs it.
- #203 supports modifier table 2; #238 retains `=== 1` checks. Preserve modifiers in restoration AND legacy-cache integrity detection.

New #311 added a raw achievement write and updated achievement state independently of #313’s ref. A naive merge reproduced both a denied-write blank screen and loss of retroactive achievements after the next live opening. Updated #313 at `201d26b` preserves shared helpers, historical references/timestamps and the reconstruction subscription using guarded persistence. Independent review, 135 branch tests and 30 development/built browser cases pass. Inspect current heads before integration.

Owner’s profile-storage question is tracked in #323 under #241. A protected minimal set/version/ticket ledger is an interim mitigation only: storage and cold replay still grow with history. The owner wants a scalable alternative; compare a recursive aggregate-proof prototype against an explicitly trusted serverless checkpoint, measuring feasibility under current Argon2id rules. Neither is implemented. Preserve save/export compatibility and label already-lost provenance rather than infer it. IndexedDB has separate/larger origin quotas; it is not durable account recovery. Top-100/achievement refs alone cannot prove full totals.

Latest card feedback is split into bounded deliveries: local Best cards retention/design #337, overall global top-10 individual-card selector contract #338, and standout-card versus combo headline decision #339. Global best versions of a particular card remain #224. Preserve card proof references independently of top-pack eviction, exclude pack multipliers from card points, and consolidate placement in #312’s one design artifact. #225 now explicitly covers generated per-board cutoffs, UTC reset/staleness and capacity gates; automatic submission remains opt-in and unimplemented. Read the linked live issues before assigning implementation children.

Weak-phone follow-up: #8 owns the measured baseline and prioritization; bounded children #340–#344 cover secondary-screen loading, startup cache hydration, foreground worker priority, local stats scans and collection mounting. Reuse #266 for swipe/particles and #226 for image recovery/cache lifetime; coordinate shared profiles.ts edits sequentially. No new phone traces were captured. Display-name policy/library evaluation is #348 under #21; existing 24-code-point checks are not profanity moderation. #222 now explicitly requests a minimal logo/featured-pack/one-action fresh landing, with quiet accessibility/guide/restore access; consolidate it in #312 rather than open another redesign tracker. These are unimplemented review proposals.

Repository readiness #308 is a Phase 1 prerequisite for contributor assignments, separate from game release readiness. Shared page/style design #312 is left for Claude: use one accessible Figma file (or one agreed prototype), linking current UX issues. The owner supplied an intended Figma file in #312; contents, Claude connection and actual authoring capability remain unverified. No design edits were made here. Local-mining acceptance is a policy proposal recorded on #223; proofs do not witness browser play/opening time, and bulk-imported scores require proof verification before global acceptance.

Latest infrastructure policy: retain owner-selected admin bypass and enabled automatic deployment. Agents using the owner identity must obey review restrictions despite the technical bypass. #349 now hardens allowed-main source/verified-artifact and production-credential boundaries while preserving automatic publishing; a pause/manual approval is not a current requirement. No live deployment tests were run. #350 is delivered by draft #354. #351 has partial draft #357 for a report-mode cold-cache runner reusing #304; warm-cache measurement and worker-network isolation remain explicit follow-ups. Neither is shipped. Review #315 → reconciled #347 and CI/protection gates first, then reliability fixes, #312’s design system and #235’s final game-readiness decision. Fix-specific regressions belong with fixes; Figma authoring capability/access must be demonstrated. Do not merge every draft regardless of scope/holds.

Phase 1 owner preparation now includes #358: brand email/recovery and official Instagram/YouTube/TikTok/Facebook/Reddit identities, reusing the LinkedIn page if already created. Registration/verification requires the owner; agents can prepare bios/assets and record public links. Account reservation is Phase 1, content production/publishing stays Phase 2. No accounts or posts were created by this update.

## Work sequence and gates

| Phase | Next work | Exit evidence |
| --- | --- | --- |
| 1. Game quality | Save/import/concurrency #181/#87; quota provenance #241; images/retry/workers #226/#228/#229; mobile/accessibility #8/#12; simpler controls/nav #182–#186/#222; tests #73/#233/#234/#239; readiness #235–#237. Optional rankings #223/#224. | No save-loss/proof/blank-screen/inaccessible-action blocker; relevant final-head CI/browser/compatibility/agent checks plus explicit manual gaps and rollback review. |
| 2. Social production/publishing | #213 bounded source-backed auto-drafts -> #38/#68 render -> exact-revision review -> #77 small manual pilot/#74 measurement -> #214 one supported authorized upload integration. | Tested durable jobs/retries/reconciliation/pause; authorized accounts/posts; written pilot repeat/change/stop decision. Drafts may start during Phase 1, promotion waits. |
| 3. Proven growth/scaling | #242 operating budgets, #225 broad auto-submission only after capacity evidence; return goals #212/#14/#52; reviewed releases/community/regional work #16/#58/#15/#79/#42/#11. | Measured service/backlog/cost/recovery limits and repeatable player/content evidence. No assumed unlimited free services. |
| 4. Future decisions | #243 optional backend RFC; trading/battles/economy/platform hypotheses remain separate. | Measured need, cost/quotas/auth/migration/privacy/outage decision; preserve guests/old proofs. A server is not a launch dependency or automatic GPU-fairness fix. |

Source finding #241: severe history quota truncation can discard original ticket-set mappings, after which profile recovery guesses sets for missing tickets. Reproduce mixed-set loss, preserve provenance or explicit loss status; don't silently replace lost packs. #87/#233 also need denied-storage startup, malformed collection JSON and pending-removal-before-record failure fixtures.

Canonical issue bodies distinguish shipped foundations, pending drafts and remaining acceptance criteria. Finite tasks have phase milestones; #1 is the live index, #227 UX tracker, #23–#34 cross-phase epics, #83 ongoing notebook. Close only full shipped/validated scope. Backlog scope labels distinguish bounded work from multi-delivery trackers; delivery plans are in issue bodies, not another document. The #228 loader fix is now draft #259; its separate retry UI #251 depends on that fix.

## Finish this review

The owner authorizes Claude to resolve approved current-phase defects and reconcile the PR queue independently or with subagents. Give each worker one bounded task and clear file ownership; coordinate shared files centrally and independently review significant changes. Work through the phase gates, not every future hypothesis at once. Verify the final combined revision, keep narrow PRs, and preserve existing merge/deployment/posting authorization boundaries. Inspect current heads again before integration.

Refresh main/PR status, work earliest blockers in small branches, reproduce/deduplicate, and validate the reconciled candidate—not only individual branches. Record remaining real-device/user/API/authorization limits. After review mark this packet completed/superseded with PR/issue links, move enduring decisions to canonical docs and remove its temporary README entry. Do not turn it into a continuously updated second operating guide.
