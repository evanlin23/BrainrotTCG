# AGENTS.md — Autonomous Agent Directives & Efficiency Protocol

## 1. Operating Mode: Fully Agentic
- Act as an autonomous software engineer. Do not pause to ask for confirmation on routine steps, standard refactors, or running diagnostics.
- Work iteratively: Plan -> Inspect -> Execute -> Test/Verify -> Checkpoint.
- Only yield execution back to the user when:
  1. The assigned objective is fully verified and complete.
  2. A critical architectural fork or missing credential blocks progress.

## 2. Token Conservation & Context Hygiene
- **External Working Memory:** Conversational history is volatile. Maintain all ongoing progress, active tasks, and architecture decisions in `STATE.md` at the repo root. Overwrite this file upon completing any milestone.
- **Diff-Driven Generation:** Never print or rewrite full files that already exist. Always apply surgical modifications, line-level replacements, or standard unified diffs.
- **Log Suppression:** When running test suites, linters, or builds in the shell, truncate or pipe outputs (e.g., `npm test -- --bail`, `pytest -q`, or pipe through `tail -n 25`). Never let 1,000+ lines of raw console logs flood the context window.
- **No Conversational Filler:** Omit conversational chatter, pleasantries, flattery, and recaps of the instructions. Prioritize dense, actionable technical reasoning.

## 3. Subagent & Delegation Schema
When breaking tasks into subagents or worker threads:
- Pass only the specific file paths, signatures, and acceptance criteria needed for the subtask. Never forward the complete conversation log.
- Enforce this strict return format from worker subagents:
  STATUS: [DONE | FAILED | BLOCKED]
  CHANGES: [Max 3 bullet points summarizing what was altered]
  DIFF: [Unified diff of modified lines only]
  ERRORS: [Failing assertion / stacktrace line only — omit passing logs]

## 4. Verification Protocol
- Never mark a task as DONE based on assumption. Run the relevant test or build command locally first.
- If a test fails, read the specific failure trace, apply a surgical fix, and re-run.
- Once tests pass and `STATE.md` is updated, stage your commit with a clean, conventional commit message.

## 5. BrainrotTCG Project-Specific Directives

- **Never Start Background Servers:** Do NOT run `npm run dev` or launch persistent Vite dev servers. They hang headless agents and flood context logs.
- **Verification Workflow:**
  - Fast typecheck: Run `npx tsc --noEmit` before running test suites.
  - Full CI check: Run `npm run check` (runs ESLint, TypeScript, unit tests, and set lock check).
- **Set Locking Protocol:**
  - If you modify `src/content/sets/*/set.json` or card definitions, you MUST update the cryptographic set lock using:
    `npm run check:sets -- --update`
  - Otherwise, `npm run check` will fail the set integrity check.
- **Adding New Sets:**
  - Use the existing repository skill in `.claude/skills/new-set` rather than scaffolding sets or prompt files manually.
- **Proof-of-Work / Card Pull Verification:**
  - When altering card derivation or cryptographic logic, verify with both the TS test suite and the Python spec:
    `python3 spec/verify_pull.py <pull_url>`
- **Asset Restrictions:**
  - Never attempt to inspect, diff, or read binary media files (`.png`, `.webp`, `.mp3`) in `public/` or `src/content/sets/*/cards/`.
