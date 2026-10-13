# Repository agent guidelines

These instructions apply throughout the repository. Use [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for code quality, compatibility, testing and issue/doc hygiene. Read only relevant domain guidance: ARCHITECTURE.md for existing boundaries, DESIGN.md for UI, ADDING_A_SET.md/spec for content or proofs. ROADMAP.md and RANKINGS.md contain proposals, not shipped requirements.

- Solve the requested problem with the smallest coherent change; reuse existing code and preserve user changes. Avoid speculative abstractions and unrelated refactors.
- Keep deterministic rules in src/engine, browser/persistence in src/game, rendering in src/components. Share rules with scripts rather than duplicate them.
- Preserve released sets, old proofs and original save/ticket provenance. Validate external inputs; never weaken verification/tests or overwrite historical outputs to bless a change.
- Use minimal authoritative state, handlers for events, effects for external synchronization, bounded async work and recoverable errors. Foreground opening and visible accessible controls come first.
- Respect active user review/merge/deployment/posting restrictions. Work in feature branches and PRs; never push directly to main. For this owner's commits use `evanlin23 <113861384+evanlin23@users.noreply.github.com>` without changing global Git identity.
- Run existing checks appropriate to changed contracts; DEVELOPMENT.md separates Actions automation, local agent audits and real-device/player evidence. Proposed runners aren't available commands until implemented. Report actual results and unrun checks, never assumed readiness.
- Reuse canonical issues; close only full shipped/validated scope. Keep agent instructions short, one doc per topic, and dated handoffs temporary. Update/remove stale guidance with related changes.
