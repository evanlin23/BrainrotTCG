# Current Claude review packet

October 13, 2026. Pending review; expires when this queue is triaged. This is a snapshot, not permanent agent guidance. Use ROADMAP.md/live milestones for sequencing and DEVELOPMENT.md for engineering/testing. Existing user review/merge/deploy/posting restrictions still apply.

## Verified baseline

Fetched main `433499f619a52ff1493ece4cacaf10e8fec4848f`, including merged #238. The initial source/docs/CI review covered #188/#203/#216 and #238; its checks used an isolated git archive of this main:

- npm run check: lint, types, 128 tests/19 files, 16 released-set locks.
- Independent Python verification: all categories in both vector files.
- npm run build: 3,057 cached preview images and 3,311 preview pages. Warm cache; entry 720.63 kB / 227.30 kB gzip triggers Vite's chunk warning (#8).
- Before #238 merged, ad hoc built Chromium initial-page smoke at 390x844 touch/mobile emulation and 1280x800 desktop: pack/images visible, HTTP 200, no page errors/failed requests. Opening/sharing/recovery and other engines were not exercised.

Dependencies were reused; no clean npm ci. Local Node 24.19/Python 3.12 versus CI 22/3.13: confirm candidate CI. No physical devices, human sessions or agent task-browser audits performed; subagents reviewed source/plans. Browser/mounted integration/local-agent infrastructure is still proposed (#73/#233/#234/#239). Prior audit: zero production dependency findings, 34 full-tree package findings (#230), not 34 demonstrated production exploits.

Branch-protection API returned 403: settings are unverified. Deploy runs npm check but not Python verification; #235/#234 must ensure required protected-main checks/no bypass or explicit release compatibility gating.

## PR reconciliation order

| PR | Review requirement |
| --- | --- |
| #216 docs | Draft. Review consolidated guidance/roadmap first; proposals are not installed features. |
| #188 usability | Draft, conflicts with main. Preserve main's protected reveals, configurable pauses, cosmetics and short-screen fixes while removing A/auto-open. Latest naming in #183/ROADMAP supersedes this earlier layout. |
| #238 background recovery | Merged into current main, CI passed. Its storage/background follow-ups below remain; memory tests do not prove durability. |
| #203 finishes | Draft based on #188. Restack after reconciliation; preserve historical files/locks/vectors and table-2 restoration/export behavior. Optional, not a prerequisite for reliability fixes. |

The October 13 follow-up reviewed all 119 open issues and 13 open PRs. Ten small drafts (#259/#268/#269/#270/#274/#275/#276/#280/#281/#282) have no identified blocking functional finding at the reviewed heads; #259 retains minor test-global cleanup. This is scoped review, not combined integration or physical-device evidence. Use live PR reviews for exact heads/checks.

Fix independent blockers without waiting for optional finishes. Old green checks do not validate the final combined head.

#203 also needs main's shared `frameRecolor.ts` extended: its older inline renderer bypasses that newer boundary. A targeted check of the exact main helper with #203 types produces missing-finish type errors and runtime failures for Neon/Cosmic/Ember. Preserve thumbnail rendering, use actual image width and generate/decode supported thumbnails before activation (#187/#237); preserve historical finish ordering. This check is not a completed merged-app build.

PR #238 checks, owned by #87/#181/#229/#233/#73/#235:

- Resume flag clears before final IndexedDB batch; swallowed transaction failures can report completion with memory-only data. Test durable reload/resume and visible failure.
- Whole-store startup hydration and all-spare-worker reconstruction need latency/memory/foreground budgets.
- Profile stats refresh but memoized history may remain stale; test pack rows/sharing after reconstruction.
- Use real browser IndexedDB/Workers for blocked/open/versionchange/quota/abort, key changes, interrupted batches and cross-tab behavior.
- Export/origin transfer omits IndexedDB: cache is discardable only if original ticket/set/version provenance reconstructs it.
- #203 supports modifier table 2; #238 retains `=== 1` checks. Preserve modifiers in restoration AND legacy-cache integrity detection.

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
