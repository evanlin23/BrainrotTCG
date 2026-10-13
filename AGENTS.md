# Repository agent guidelines

These instructions apply throughout this repository. Read [docs/CODE_QUALITY.md](docs/CODE_QUALITY.md) before changing application code. Use [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for existing boundaries and [docs/DESIGN.md](docs/DESIGN.md) for the design system. Product proposals in [docs/SIMPLIFICATION.md](docs/SIMPLIFICATION.md) and [docs/RANKINGS.md](docs/RANKINGS.md) remain proposals, not implemented requirements.

## Working agreement

- Solve the requested problem with the smallest coherent change. Inspect existing components, helpers, tests and issues before adding another mechanism. Preserve user changes.
- Do not rewrite adjacent features, introduce speculative abstractions, or add dependencies without explaining the concrete need. Remove obsolete code caused by your change; leave unrelated cleanup for its own PR.
- Keep commits on feature branches and submit PRs, never push directly to main. For this owner's work use `evanlin23 <113861384+evanlin23@users.noreply.github.com>`. Do not modify global Git identity.
- Current review hold: work prepared in this session, including these guidelines and PRs #188, #203 and #216, must remain draft until Claude reviews it. Do not merge or deploy it. Review permits consideration; merging still needs user authorization or an explicitly authorized workflow. Continue drafting and validation without repeatedly asking permission.
- Search existing issues before creating new ones; follow [docs/ISSUE_HYGIENE.md](docs/ISSUE_HYGIENE.md). A draft PR does not mean an issue is resolved. Keep observed bugs distinct from hypotheses.

## Code and UX rules

- Keep deterministic rules in `src/engine`, browser/persistence glue in `src/game`, and rendering in `src/components`. Share scoring/eligibility rules with scripts; never duplicate them in UI.
- Derive values from existing state instead of synchronizing copies with effects. Use event handlers for user actions, effects for external synchronization, and explicit states for async workflows.
- Validate untrusted input at boundaries. Preserve old proofs, released sets and local saves. Never weaken signatures or checks to make a test pass; see the versioning checklist in CODE_QUALITY.md.
- Make async work cancellable or ignore stale completion; clean up listeners/timers/workers and bound queues/caches/retries. Errors need a recoverable visible state, not an indefinite spinner or blank card.
- Keep one obvious primary action, familiar labels, consistent navigation, and visible click/tap/keyboard alternatives. Secondary features must not obscure opening or sharing. Accessibility controls are available from the start. Do not reintroduce A-toggle/auto-opening without an explicit product decision.
- Reuse design tokens and shared Sheet/Tabs/buttons/card treatment. Respect reduced motion, focus handling, image dimensions and mobile performance. Never hide useful controls behind an undisclosed shortcut.

## Validation and handoff

Follow [docs/TESTING.md](docs/TESTING.md): select unit, component, integration, browser, compatibility and workflow checks from the changed contracts, then report actual results and unrun checks. For meaningful user-flow changes, include the independent subagent task-audit stage described there when tools are available; use isolated contexts, no source coaching, coordinator triage, and explicit real-player/device limits. Proposed test infrastructure is not an available command until implemented.

- For application changes run `npm run check`; run `npm run build` for changed bundling/assets/export/preview generation. Also run relevant browser checks for affected UI states and the independent-verifier CI-equivalent for proof/generator changes. Consult `.github/workflows/ci.yml` for exact commands.
- Add regression tests for meaningful behavior changes and reproduced bugs; do not add tests that merely restate implementation or test trivial copy edits. Docs-only changes need link/consistency review and `git diff --check`, not an unnecessary full build.
- Report what changed, why, checks actually run and material limitations. Never claim a device test, measurement, deployment or merge happened without evidence. Update affected docs with behavior changes.
