# AGENTS.md — Autonomous Agent Directives & Efficiency Protocol

These instructions apply throughout the repository. Use [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for detailed code quality, testing, and issue/documentation hygiene. Read only relevant domain guidance: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DESIGN.md](docs/DESIGN.md), [docs/ADDING_A_SET.md](docs/ADDING_A_SET.md), or [spec/PULL_SPEC.md](spec/PULL_SPEC.md).

## 1. Operating Mode & Contributor Controls
- Act as an autonomous software engineer. Work iteratively: Plan -> Inspect -> Execute -> Test/Verify -> Checkpoint.
- **Branching & PRs:** Always work in feature branches and open PRs. Never push directly to `main` or publish/deploy as a test.
- **Owner & Authorship:** Respect active owner review, merge, deployment, and publication restrictions. Passing CI is not permission to merge or deploy. For owner commits, use `evanlin23 <113861384+evanlin23@users.noreply.github.com>` without changing global Git identity.
- **Reporting Evidence:** Report actual steps, final-head test evidence, and unrun checks. Never claim assumed readiness or pass based on assumption.

## 2. Token Conservation & Context Hygiene
- **Task-Local Scratchpad:** Conversational history is volatile. Maintain active progress and architecture notes in a task-local scratchpad file (e.g. `STATE.md` or `*.state.md` at repo root). Scratchpads are ignored from git and must not replace reviewed architecture docs or issues.
- **Diff-Driven Generation:** Apply surgical modifications and line-level diffs. Never print or rewrite complete existing files unnecessarily.
- **Log Suppression & Exit Status Preservation:** Truncate or pipe shell outputs to save context, but always preserve the underlying command status by using `set -o pipefail` or checking `$?` (e.g. `set -o pipefail; npm test | tail -n 25`). Never let log suppression mask test or build failures.
- **No Conversational Filler:** Omit chatter, pleasantries, and instruction recaps. Prioritize dense, actionable technical reasoning.

## 3. Subagent & Delegation Schema
When breaking tasks into worker subagents:
- Pass only specific file paths, signatures, and acceptance criteria needed for the subtask. Never forward complete conversation logs.
- Enforce strict return format:
  `STATUS: [DONE | FAILED | BLOCKED]`
  `CHANGES: [Max 3 bullet points summarizing what was altered]`
  `DIFF: [Unified diff of modified lines only]`
  `ERRORS: [Failing assertion / stacktrace line only — omit passing logs]`

## 4. Verification Protocol & Server Management
- **Verification Workflow:**
  - Dependency install: Use `npm ci` when installing dependencies, preserving `package-lock.json`.
  - Typechecking: Run `npm run typecheck` (or `npx tsc --noEmit`) before running test suites.
  - Full CI check: Run `npm run check` (runs ESLint, TypeScript, unit tests, and set lock check).
- **Bounded Preview/Build Servers:**
  - Persistent background dev servers must not be left hanging.
  - When browser smoke, visual, or E2E verification requires a running server, start a bounded, owned build/preview server (e.g. `npm run preview`), verify readiness with health checks, complete testing, and ensure cleanup/shutdown of owned server resources.

## 5. BrainrotTCG Project-Specific Directives

- **Set Locking & Released-Set Immutability:**
  - Released sets, historical proofs, and card provenance are immutable.
  - `npm run check:sets -- --update` adds new set locks for newly added sets, but deliberately refuses changed existing set locks. Never modify released set outputs to force checks to pass.
- **Adding New Sets:**
  - Use the existing repository skill in `.claude/skills/new-set` and follow [docs/ADDING_A_SET.md](docs/ADDING_A_SET.md) rather than scaffolding manually.
- **Proof-of-Work & Cryptographic Verification:**
  - When altering card derivation or cryptographic logic, verify with the TS test suite and run both historical Python vector files using an isolated interpreter:
    `python3 -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json`
- **Asset Restrictions & Inspection:**
  - Never dump or print raw binary media files (`.png`, `.webp`, `.mp3`) into console logs or context.
  - Use dedicated inspection tools (`view_image`, `read_media_file`) when visual inspection of card assets or previews is required.
