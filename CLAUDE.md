# CLAUDE.md

Brainrot TCG: a static React 19 + Vite pack-opening game. Packs come from Argon2id proof-of-work
tickets and are shared as Ed25519-signed proofs that anyone can re-derive. There is no server:
GitHub Pages hosts it, GitHub Issues and Actions run the Hall of Fame. Merges to main deploy
automatically.

## Rules the code won't tell you

- Layers: deterministic rules in `src/engine` (no React or DOM), browser and storage in `src/game`,
  UI in `src/components`. Scripts import engine code instead of copying rules.
- Released sets and old proofs are permanent. Changing a released set's cards, order, rarities, odds
  or pack size needs a new set version (docs/ADDING_A_SET.md). Engine changes that alter packs need a
  new ticket or proof version. Never regenerate vectors or locks to make a failing check pass.
- Saves: validate before writing, never mix player identities, recover from storage quota errors.
- Never push to main, use the admin bypass, or deploy or submit real data as a test.

## Checks

- While iterating: `npx vitest run <path>` for what you touched, `npx tsc --noEmit -p .` for types.
- Before pushing: `npm run check` (lint, types, all tests, set locks), once.
- CI runs `npm run build` and the independent Python verifier on every push. Leave those to CI unless
  you changed `src/engine`, `spec/` or the build.

## Docs (read only the section you need)

docs/ARCHITECTURE.md (proofs, storage, Hall of Fame, invariants), spec/PULL_SPEC.md (proof format),
docs/DESIGN.md (UI), docs/ADDING_A_SET.md and docs/ART_STYLE.md (sets, or run /new-set),
docs/HOSTING.md (deploys).

## How work runs here

The owner wants hands-off engineering from one Claude window, within a weekly usage limit.

- `/work` runs the queue. The main thread coordinates and stays small: it holds the ledger in
  `.claude/state/NOW.md`, briefs, and short reports. Each task runs in a fresh `implementer`
  subagent and gets an independent `reviewer`. A SessionStart hook re-injects the ledger after
  compaction or /clear.
- The owner allows Claude to close duplicate, superseded or obsolete PRs (with a one-line reason)
  and to merge PRs. Merge only when CI is green on the final head, a reviewer approved it, it is up
  to date with main and it isn't on hold in the ledger. Then check main's CI and deploy.
- Ask the owner only for external access or decisions that are genuinely theirs. Add them under
  `needs owner` in the ledger and keep working on other items.

## Token budget

- Locate, then read: Grep or Glob first, then Read with offset/limit. Don't open package-lock.json,
  spec/vectors*.json, CREDITS.md files or images unless the task is about them.
- GitHub: pass `fields` and `perPage` of 10 or fewer on list and search calls. To review PR code,
  `git fetch origin <branch>`, then `git diff --stat` and per-file diffs, not whole-PR dumps.
- Command output: summarize it. On failure quote only the failing test or lines.
- Don't re-run checks that passed on unchanged code, or re-read files already in context.
- Subagents: `implementer` and `reviewer` for tasks; `scout` (cheap search), `researcher` (web) and
  `pr-triage` (queue sizing) run on cheaper models. The built-in Explore and general-purpose agents
  use the main model, so prefer these. Brief each one with only what it needs and ask for a short
  report. Run implementers one at a time: they share the checkout.
- Long handoff docs, audits and issue threads: have a subagent distill them into the ledger instead
  of reading them in the main thread.
- Reports, PR bodies and issue comments: what changed, what ran (pass or fail), what didn't run.
- Every wake-up re-reads the whole context. Subscribe only to PRs you opened, and hand CI fixes to
  an implementer.

## Compact instructions

Keep: the ledger's authority, holds and order, the current task and its acceptance criteria,
decisions and why, PR numbers and head commits, the last result of each check, unresolved failures
or review findings, and the next step. Drop: file contents, diffs, search results and passing logs.
