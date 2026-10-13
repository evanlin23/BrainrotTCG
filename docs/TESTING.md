# Agent verification workflow

Draft guidance for Claude review, linked from AGENTS.md. This is a testing plan plus commands that already exist. Browser/integration infrastructure described as proposed below is not installed by this docs PR. No test plan guarantees zero defects; the goal is reproducible evidence for the affected contracts.

## 1. Establish scope before changing code

Read AGENTS.md, package.json, .github/workflows/ci.yml and the existing tests nearest the feature. Record the base/head commits, intended behavior and compatibility requirements. Map the change to the layers below. Reproduce a reported bug before fixing it when possible; otherwise mark its cause unconfirmed and define a reproduction experiment.

Use an isolated browser context and disposable storage. Never test destructive import/reset against someone's real save, send live relay/GitHub submissions, post social content, or deploy a production build as a testing shortcut. Exported player saves contain private keys; use deterministic test-only identities, never attach real saves to artifacts. Use fake adapters for external writes. The proposed browser harness must block unexpected outbound network by default and intercept relay/GitHub/social destinations with fake endpoints; instructions alone do not prevent incidental app submissions. Explicitly allow only required local fixture assets. A production read-only smoke check is separate from a deployment.

## 2. Choose the right layers

| Layer | Purpose | Repository baseline / proposed work |
| --- | --- | --- |
| Static checks | Invalid types, hook misuse, unused code and immutable set changes | Existing npm run lint, npm run typecheck, npm run check:sets |
| Unit | Pure rules, parsers, state transitions, ordering, migration validation, queue accounting | Existing Vitest engine/game/utils tests; add focused failure cases with fixes |
| Component interaction | Mounted controls, effects, image errors, keyboard/focus and loading state | Current server-rendered component tests check markup only; mounted browser/DOM tests are proposed, choose one shared setup |
| Integration | Real collaborating modules with fake external boundaries: open/record/reload, import/rollback, verify/intake/snapshot | Existing inbox/relay/history tests give partial coverage; cross-module harness is proposed |
| End-to-end | Actual built app, browser workers/storage/assets and player task sequences | Proposed under #73; no npm browser-test command exists yet |
| Contract/compatibility | TypeScript/Python agree; old proof/set/save formats still work | Existing spec vectors, set lock, independent-verifier CI; add explicit supported save fixtures |
| Workflow | Intake/build behavior, permissions and packaging without real writes | Pure inbox tests exist; broader workflow fixture/dry-run checks are proposed |
| Accessibility/visual/performance | Focus/readability/layout, image rendering, and actual phone responsiveness | Manual/browser device checks plus proposed #73 automation; screenshots alone prove none of the others |

Prefer a few tests that assert important observable behavior over many tests mirroring internal function calls. Use the smallest layer that catches the defect, then add an integration/browser case when a boundary is involved. Avoid duplicating every unit case in E2E. Do not use line coverage or snapshot count as the definition of correctness.

## 3. Existing commands

Run from the repository root with the CI-supported Node version (currently 22); preserve the committed lockfile and use npm ci when installation is needed.

```sh
npm run check
npm run build
```

`check` runs ESLint, both TypeScript projects, Vitest and released-set validation. `build` runs Vite and static preview generation; it may take minutes when the preview cache is cold. CI runs both for application PRs. Reuse a valid preview cache but exercise a cold run when its invalidation/build logic changes.

For a focused iteration use the existing runner, for example:

```sh
npm test -- src/game/history.test.ts
```

Finish an application change with npm run check. CI also requires build; run it locally for packaging/assets/exports and resolve CI's build result before calling the PR fully verified. For proof/generator/spec changes also run the independent verifier using the isolated Python environment with the CI Python version (currently 3.13) and pinned cryptography package (currently 50.0.1). Activate that environment or invoke its interpreter explicitly; the command below assumes python resolves to it, not an arbitrary system installation:

```sh
python -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json
```

Inspect CI if versions or commands change; do not invent a test:e2e script. Docs-only work needs local-link/consistency review and git diff --check. A failure, skipped test or zero-test invocation is not a pass. Do not hide exit status through logging pipelines.

## 4. Required cross-module contracts

Integration fixtures use real generation/scoring/encoding where that is the contract, and fake storage/network/clock/worker boundaries where deterministic fault injection is needed. Do not stub the function whose correctness the test is meant to establish. Keep a small real Argon2/proof path; use known vectors or a test-only adapter for repeated presentation scenarios. Test-only overrides must not ship a production way to fake verified pulls.

- Opening: one allocated ticket/identity produces the expected versioned pack; reveal, skip or exit records it exactly once; remount/reload and interrupted opening recover consistently. Save failures do not claim success or award twice.
- Persistence: export/import round trip preserves identity/history/modifiers/progression; invalid identity, malformed-but-valid JSON, quota failure mid-write and supported legacy formats preserve or recover the old save. Host migration uses the same replacement guarantees and validates message origin/source.
- Concurrency: two same-origin browser pages sharing storage exercise simultaneous ticket allocation, rename/import during mining, and signing while another tab records. Separate browser contexts do not share localStorage and cannot reproduce this race.
- Sharing: every pack entry point opens the same card treatment and supports individual-card/pack actions. Generated image decodes, has expected dimensions and preserves modifiers; proof link independently reconstructs the result. Clipboard/share cancellation is recoverable. Do not assume a fake clipboard proves an OS share sheet works.
- Ranking/intake: real proof verification and pure selectors feed fake transport/filing; duplicate events, invalid signatures, limits, interrupted filing, retries and moderation/rebuild work. Daily/per-card/stale-cutoff contracts apply only when those proposals are implemented; they are not current shipped features.
- Async recovery: failed HTTP then success, invalid snapshot, worker constructor/load/crash, fallback bounds, close, late completion and image decode/generation failure. Bounded queues do not silently lose plausible winners.

## 5. Browser task matrix

Use the built app served locally for packaging smoke, not only Vite dev mode. Start npm run preview after a build, verify an actual page/asset response, and use isolated contexts. The proposed harness must commit its runner/browser versions, document installation and the exact serve URL (including /BrainrotTCG/ for that build base), detect readiness, and stop only processes it started. A PID or open port is not a functional check. Keep valid proof fixtures for ordinary and rare/modifier states; do not mine randomly until a rare test finally passes.

Minimum smoke journey: fresh visit -> open -> reveal/skip -> result -> card detail -> share -> My cards/current equivalent -> reload -> same saved result. Also verify a valid shared pull and an invalid link. Test current behavior; future labels/unlocks become expectations only after implementation.

For UI changes add affected cases: 390x844 and short/narrow phone viewports, desktop keyboard, visible Space/click alternatives, text-input shortcut exclusion, nested sheets, Tab/Shift-Tab/Escape, reduced motion, resizing mid-reveal, background/foreground return, image failures, slow network and retries. Check visible actions and stable card geometry, not just a screenshot. Capture browser page errors, failed asset requests, and unhandled rejections; distinguish expected injected failures from unexpected errors.

Proposed automated browser coverage: Chromium smoke on PRs; focused Firefox/WebKit plus failure/concurrency/visual scenarios on relevant changes or scheduled/manual runs. Browser-engine emulation is not an Android/iPhone hardware test. Actual phone and screen-reader checks remain required for mobile/accessibility release claims. Visual baselines use stable fixtures, fonts and motion; reviewers must inspect changed baselines rather than bulk-accept them.

## 6. GitHub workflow and static-host checks

Check workflow syntax with a documented supported validator once added; review permissions, fork-PR behavior and external action versions. Do not execute secret-bearing/deployment workflows against live destinations to test syntax. Integration-test scripts with fake GitHub/relay adapters and disposable output directories. Fixture cases cover event payload parsing, intake budgets, cache invalidation, verified/rejected issue selection, snapshot generation and interrupted/repeated runs.

Test build output at both configured host bases when base-path/hosting/redirect logic changes: assets and shared-link previews resolve correctly, old version links remain usable, and migration validates origins. A local valid build does not prove the external host serves it. After an authorized deployment, separately check expected build identity and public asset/proof routes. The current review hold excludes deploying these drafts.

## 7. Speed, flakiness and evidence

Keep tests independent, restore globals/mocks/storage and close workers/contexts. Inject clocks for rollover/backoff; avoid fixed sleeps in favor of observable completion with bounded timeouts. Use seeded fixtures. Retry only an identified transient infrastructure failure, recording the initial failure; a pass on retry alone is not proof of correctness. Quarantines need an issue, owner and exit condition and must be visible in CI.

Proposed CI split: fast static/unit/integration gate, browser smoke gate, existing independent-verifier gate, and build/preview validation; heavier real-device/performance and expanded browser runs provide separate release evidence. Do not duplicate builds unnecessarily. Adopt runtime/coverage budgets from measured baseline; prioritize branches around save/verification/error contracts instead of imposing an arbitrary global percentage.

Every handoff includes:

```text
Change / base and head commits:
Acceptance criteria exercised:
Commands and results (including test counts/skips where available):
Browser/device/network and flows checked:
Fault injection / compatibility fixtures:
Unexpected failures and linked issues:
Not run / blocked / manual checks still needed:
Artifacts (sanitized screenshots, trace, report):
```

Artifacts must belong to this run and avoid private keys, credentials and personal data. Keep them small with defined retention; don't commit generated test output or add a second permanent QA notebook. PR validation records the evidence, issues own unresolved gaps, and this doc owns the reusable workflow.

## Execution locations and merge evidence

| Check | Local iteration | GitHub Actions / review gate |
| --- | --- | --- |
| Lint/typecheck/unit/set-lock | Existing commands | Existing check job |
| Cross-module integration/component interaction | Proposed #233 harness | Add to deterministic CI gate once implemented |
| Build/static assets/workflow fixtures | Existing build plus proposed #234/#237 checks | Build already required; add fixture/asset jobs |
| Independent Python verification | Isolated CI-compatible environment | Existing independent-verifier job |
| Browser E2E/visual/accessibility smoke | Proposed #73 browser commands | Proposed pinned-browser CI jobs, no live external writes |
| Agent task audit | Local Claude or another supported agent CLI | Attach report to PR; not a hosted model/privileged CI job |
| Physical phone/screen reader/human sessions | Explicit manual sessions | Attach separate release evidence; cannot substitute emulation |

Actions may run deterministic automated tests for every PR, with broader browser/performance checks scheduled or selected by affected contracts. Interactive local agent audits do not require model credentials in Actions. Document the supported CLI/setup only after testing it; no imaginary invocation commands. Normal CI tests must remain runnable without an agent subscription.

For each change, choose named checks from the contract matrix and record any applicable check not run. Before a readiness decision reconcile evidence against the current head commit; changes after an audit require relevant retests. A docs update does not mean the proposed new CI jobs exist. Keep required checks enforceable through reviewed repository settings/workflows, avoid granting test jobs deployment permission, and link unresolved failures to canonical issues. Local audit orchestration has its own issue; #234 owns the deterministic workflow split and #73 the browser matrix.

## 8. Independent subagent usability audits

For meaningful onboarding/navigation/reveal/share changes and release-readiness reviews, add an independent agent audit after the affected automated checks. The user has authorized subagents for this work. This is browser-assisted usability review, not a unit-test replacement or evidence about real people. If browser tools or subagent slots are unavailable, report that stage unrun rather than invent a session.

The coordinator prepares one known built-app revision and isolated contexts with fresh storage, safe test identities and blocked external writes. Keep the server/readiness and browser fixture setup shared; give each agent a separate context/output location. Agents review only: no concurrent app edits, shared-storage resets or issue creation. Use two same-origin pages inside one context only for the explicit multi-tab concurrency scenario.

Start reviewers without inherited conversation/product history where supported. Give only the local app URL, viewport/browser setup, safe-network rules and the assigned task. Do not reveal expected menu names, hidden shortcuts or the correct route. This reduces coaching but does not make model behavior equivalent to human unfamiliarity. A technical reviewer may inspect source separately; a task reviewer must not inspect source/docs or receive navigation hints during the session. Label coached reruns separately.

Suggested task assignments (combine when agent capacity is limited):

| Reviewer | Task and environment |
| --- | --- |
| First opening | Fresh touch/mobile-sized context: open a pack, explain the result, open another. Identify which controls were discoverable without coaching. |
| Card understanding and sharing | Explain rarity/modifiers from visible help, open a card detail and attempt card/pack sharing. Use fake clipboard/share boundaries; report that native OS sharing was not validated. |
| Finding personal/global results | Find your best pull and explain Today’s submissions versus All-time submissions. Use deterministic saved fixtures only after the fresh-visit task, clearly labeling the fixture. |
| Accessibility and recovery | Keyboard/reduced motion, nested dialogs, text-entry shortcuts, short-screen resize, background return, failed image/slow-network recovery. Report actual checks, not a blanket accessibility pass. |

Use Chromium/Firefox/WebKit where the harness supports them. Include a narrow/short viewport and touch emulation. Record engine, viewport, touch setting, network/CPU throttle and cache state; user-agent strings alone do not establish device emulation. CPU throttling is an approximation and WebKit testing is not a physical iPhone/Safari test. Browser automation infrastructure remains proposed under #73 until installed.

Each agent records task outcome (completed/blocked/ambiguous), actual action sequence and unnecessary detours, visible labels that caused confusion, errors and sanitized screenshots/trace. Record elapsed time as an agent observation, not a human usability metric. Separate reproducible defects from preference/hypothesis. Do not demand that agents deliberately miss a control to produce findings or count multiple agents as independent human participants.

The coordinator checks reports against the same revision, reproduces suspected bugs, merges overlapping findings and searches existing issues. Update canonical owners (#73 automation, #211 comprehension/newcomer review, #183 navigation, #226 images and relevant save/ranking tickets); create a new issue only for a distinct validated gap. Attach reproduction/acceptance criteria, not an unfiltered transcript. Human review still decides product preferences; agents cannot approve merging around the Claude hold.

Rerun affected task audits after fixes, using fresh contexts and no hints, with a reviewer who did not implement the fix where feasible. Compare concrete task steps and failures rather than claim population-level improvement. Publish the combined evidence in the PR: automated suites, agent audit results, remaining real-device/player checks and blockers. Do not close #211's real-player acceptance criteria based solely on subagent sessions.

The full flow is: scope/contracts -> focused unit/component checks -> cross-module integration/compatibility -> built-app browser/failure matrix -> independent agent task audit -> coordinator reproduction/issue hygiene -> affected retest -> review/readiness decision. These stages scale to change scope; trivial copy/docs changes do not need an entire browser/agent exercise. Actual publication or deployment remains a separately authorized action.

## Issue ownership and implementation status

- #233 owns the shared cross-module integration/component harness and deterministic fault injection.
- #73 owns browser E2E, interaction, visual and accessibility smoke automation.
- #234 owns safe workflow/packaging fixture tests and documented workflow validation.
- #8/#12/#211 retain measured phone performance, accessibility and newcomer validation; emulated tests cannot close those alone.

The existing Vitest/check/build/independent-verifier commands are available. Additional harnesses, browser scripts and workflow validators above are proposals, not installed tools or passing suites.

#239 owns the local Claude/agent audit runner, prompt templates, resource limits and sanitized evidence reports. It is proposed infrastructure, separate from Actions test jobs.
