# Development and verification

Use this guide for changed code; read domain docs only when relevant. Scripts and CI are the executable source of truth. Product proposals are not implemented requirements.

## Engineering rules

- Make the smallest coherent change; reuse stable helpers/components, remove obsolete paths and avoid speculative frameworks/dependencies or unrelated cleanup.
- Keep deterministic rules in src/engine, browser/persistence in src/game, presentation in components and tooling in scripts. Share scoring/eligibility rather than duplicate it.
- Name state precisely, validate external data, derive render values instead of synchronizing copies, use handlers for actions and effects for external synchronization. Comments explain constraints/reasons.
- Record once independently of animations. Handle errors, duplicates, cancellation and stale completion; clean up owned resources and bound queues/caches/retries. Foreground opening and accessible visible controls take priority.
- Preserve released sets, historical proofs and original ticket/set/version provenance. Deterministic changes need the applicable version/spec/vector/verifier updates; never bless changed old outputs. UI layout normally doesn't affect generation.
- Validate replacement saves before writing; recover from quota/interruption without silently mixing identities. Card caches are discardable only if retained provenance can reconstruct them. Public proofs never contain private keys; exports are private.

## Automated checks and where they run

| Coverage | Existing or proposed | Execution |
| --- | --- | --- |
| Lint/types/unit/set locks | npm run check, existing | Local and Actions |
| Build/static previews | npm run build, existing | Local for packaging/assets; Actions |
| Independent verification | Python vectors, existing | Local isolated environment and Actions |
| Mounted component/cross-module integration | #233, proposed | Local and Actions |
| Built-browser E2E/visual/a11y smoke | #73, proposed | Local and Actions |
| Workflow/asset validation | #234/#237, proposed | Fake-provider local/Actions checks |
| Independent agent task audit | #239, proposed runner | Local Claude/other supported CLI; attach report |
| Actual phone/screen-reader/newcomer checks | #8/#12/#211 | Separate manual release evidence |

Run npm ci when installation is needed; preserve the lockfile. Application changes finish with npm run check; CI also requires build. For generation/spec changes run `python -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json` through an isolated interpreter matching CI (currently Python 3.13/cryptography 50.0.1; Node 22). Inspect workflows for current versions. Docs-only: local-link/consistency review and git diff --check. Proposed commands aren't available until implemented. Zero-test/skipped/failed runs aren't passes.

Choose meaningful regressions by changed contract, not a global coverage target:

- Open/record/reload/skip/exit exactly once; interrupted/save-failed openings recover without duplicate awards.
- Valid/legacy export-import, malformed JSON shapes, wrong identity, denied storage, quota mid-write, pending recovery and severe mixed-set history truncation preserve provenance/state.
- Same-origin pages in one context test shared-storage races; separate contexts don't. Real IndexedDB reload/quota/transaction/blocked cases cannot be proven by memory mocks.
- Card/pack sharing works across entry points; exports decode/preserve modifiers and proof links reconstruct. Fake share/clipboard APIs don't validate native OS UI.
- Intake verifies real proofs with fake relay/GitHub boundaries: duplicates, invalid signatures, limits, retries, partial filing, removal/rebuild; daily/stale/per-card contracts when implemented.
- Async cases: HTTP failure then recovery, malformed snapshots, worker crash/no-worker/close, bounded fallback, late results and missing/failed images.

Built-app smoke: preview the build at its configured base URL; verify actual page/assets, not a PID. Use deterministic verified fixtures, isolated test identities/storage, pinned runner/browser versions and blocked outbound writes. Exercise fresh opening -> result -> card/share -> personal results -> reload, plus valid/invalid proof links. Relevant cases include touch/narrow/short layouts, keyboard/form exclusion/nested focus/Escape, reduced motion, resize/background return and slow/offline/failed assets. Assert behavior and unexpected errors, not screenshots alone. Stop only owned resources.

Chromium smoke can gate PRs; relevant Firefox/WebKit/visual/failure expansion can run in Actions or scheduled/manual jobs once #73 exists. Emulated touch/network/CPU/browser engines are not actual phone/GPU/native-share evidence. Workflow tests use fake adapters/disposable outputs, verify payload/permission/cache/budget/base-path/origin contracts and never deploy or publish to test. Cold cache rebuilds matter when generation/invalidation changes.

## Local agent review and handoff evidence

For meaningful user-flow changes, a coordinator supplies a known built revision and safe contexts. Independent reviewers get task-only prompts without inherited product history, source/docs, expected labels/routes or shortcut coaching. Assign opening, rarity/share, personal/global results and accessibility/recovery tasks; fresh contexts for newcomers and clearly labeled fixtures for returning flows. Reviewers are read-only; no real saves, external writes or merges. Bound agents/time/provider costs; tools unavailable means unrun.

Report actual steps, completed/blocked/ambiguous outcomes, detours, labels, errors and sanitized artifacts with engine/viewport/touch/network/cache settings. Coordinator reproduces/deduplicates findings into existing issues, then retests affected tasks without coaching. Agent times/outcomes are not human statistics and don't replace real newcomers/devices. Normal CI needs no agent subscription or hosted model credentials.

Each PR records tested commit, criteria, commands/results/counts/skips, browser/device/conditions, relevant fault/compatibility cases, sanitized artifacts, unresolved issues and checks not run. Reconcile evidence against final head. Keep tests independent/seeded, restore mocks/storage, close contexts/workers, use observable completion with bounded timeouts and retain failure evidence. Retries/quarantines need a cause/issue/exit condition; don't hide flakiness or weaken checks.

## Issue and documentation hygiene

Search/reuse canonical issues. Milestones sequence phases without promises/dates. Close only full shipped/validated scope; use Refs for partial/tracking work. Distinguish hypotheses from reproduced bugs. Current evidence belongs in PRs/issues, durable contracts in domain docs. Keep one owner per topic; edit existing guidance before adding a doc. Retire dated handoffs after review and remove their temporary links. Agent entry files stay short and must not direct every future task through old handoffs.

Reviewed source principles: [Google code review](https://github.com/google/eng-practices/blob/master/review/reviewer/looking-for.md), [React effects](https://github.com/reactjs/react.dev/blob/main/src/content/learn/you-might-not-need-an-effect.md), and [Anthropic code simplifier](https://github.com/anthropics/claude-code/blob/main/plugins/pr-review-toolkit/agents/code-simplifier.md): preserve behavior, favor clarity over dense brevity, simplify changed code and avoid over-engineering. These are references, not plugin installation or adoption of every example style rule. Hosted Claude/Codex guide pages returned HTTP 403 and were not reviewed; accessible official GitHub material was used instead.
