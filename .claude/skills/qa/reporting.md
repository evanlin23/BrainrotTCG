# Evidence and decisions (load before creating issues/PRs)

Use the repo's Bounded task form (`.github/ISSUE_TEMPLATE/bounded-task.yml`) and PR template.
Keep public evidence sanitized; link committed fixtures/checks by path and SHA, not raw saves,
proof/query/hash payloads, private keys, participant identities, full traces or provider streams.

## Canonical issue

- Player impact and severity with rationale; label source as scripted QA, simulated player with
  selected provider/host, or consented human observation. Don't infer prevalence or human success.
- Exact faulty/build SHA, target, browser/version, dimensions/input/motion/cache, fixture and
  network/CPU conditions; exact task/date, provider/host/model (unknown if unexposed), tools/isolation
  limits, caps/usage and blocked actions for simulation. State repro separately from reported claims.
- Minimal numbered repro; expected contract versus actual result; bounded sanitized evidence.
- Observable acceptance; scope/exclusions; prerequisites, conflicting PRs and dependencies.
- Proposed owner/branch coordination (not an assignment claim), owning regression/check paths and
  commands, unrun checks; **root-cause hypothesis** explicitly labeled until established.

## Genuine draft fix PR

- Problem and changed behavior; canonical issue via `Fixes #n` for full scope or `Refs #n` otherwise.
  An evidence-only PR never fixes a product defect; don't create one to satisfy a finding quota.
- Base and exact final head; regression fail-before/pass-after (SHAs, command and result, not a
  setup failure); targeted/full/domain/browser results by SHA/config/environment, and unrun checks.
- Visible changes: sanitized before/after observations and required fresh task audit on final head,
  or exact external/budget blocker. Browser emulation and injected APIs remain labeled.
- Defect learning: root cause with source evidence; pre-existing defect versus introduced regression
  (introducing commit only if traced); escape class and missed control/test evidence; lowest useful
  regression level; sibling scan; one bounded prevention action/check or canonical follow-up owner.
  Use DEVELOPMENT.md's escape classes; don't add overlapping tests or widen the fix.
- Independent review head/verdict/findings and remaining risks; dependencies, CI IDs, outstanding
  human/device/native-share/AT checks. If later review changes the head, refresh affected evidence.

## Compact final/resumption report (at most 12 lines)

Scope/target, base and tested SHAs, time/journeys/provider starts/draft fixes used and remaining;
selected provider/host/model, tools/isolation, scripted/simulated outcomes/conditions and blocked actions;
confirmed vs duplicate vs ambiguous observations (tool elapsed time isn't human reaction time);
canonical issue → active/draft PR → exact head; checks pass/fail/blocked/unrun; reviewer head/verdict;
dependencies/holds/owner decisions; pending CI/evidence and specific next action. Preserve already
completed work and exact-head validation on resume. A clean slice means no confirmed defects in
the tested conditions, never that the whole product is bug-free.

## Dry-run decisions (reason through these; no live audit or GitHub mutations)

| Situation | Required decision |
| --- | --- |
| Current repro matches an open issue and another author's active PR | Reuse both, attach only material evidence; no new issue, PR or parallel writer. |
| Novel contract violation reproduced on the exact fixture/SHA; safe small fix exists | Refresh dedupe/holds, file bounded issue, implement real regression-backed fix, independent review, leave draft. |
| Claude CLI missing/wrong pin/signed out, or its isolation check fails | Claude mode blocked/unrun; don't bypass checks. Continue available authorized native ChatGPT/Codex simulation or deterministic QA within budget; state provider selection. |
| Claude CLI missing; native ChatGPT subagents and a guarded browser are available | Load chatgpt.md and use host subagent APIs with fresh task-only participants; no Claude install or invented CLI provider option. Disclose ambient tools/source access and actual adapter conditions. |
| Native browser effects can't be contained, or participant budget is exhausted | Mark that mode/task blocked or unrun; continue safe deterministic QA, never count an unsupported action as passed. |
| Held item or patch risks saves/old proofs; authority unavailable | Keep read-only evidence, state the hold/risk and required decision; don't start unsafe fix. |
| Observation doesn't reproduce, or no product diff is justified | Record ambiguous/unconfirmed result; create no defect or empty/report-only PR. A confirmed defect with no safe patch keeps its issue and explicit blocker. |
