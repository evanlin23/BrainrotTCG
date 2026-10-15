# Development and verification

Workflow and checks for contributors. Repo rules (layers, compatibility, saves) are in
[CLAUDE.md](../CLAUDE.md); domain contracts are in [ARCHITECTURE.md](ARCHITECTURE.md),
[PULL_SPEC.md](../spec/PULL_SPEC.md), [ADDING_A_SET.md](ADDING_A_SET.md) and [DESIGN.md](DESIGN.md).
If this page disagrees with `package.json` or `.github/workflows/`, those win.

## Setup

Use Node 22, as CI does. `npm ci` installs from the lockfile; only change `package-lock.json` in a
dependency change. `npm run dev` starts the app; `npm run build && npm run preview` serves the built site.

## Workflow

1. Search open issues and PRs first and reuse the existing issue. New work starts from the
   "Bounded task" form; an issue labelled `scope:needs-slicing` is split before anyone takes it.
2. Branch from current main. Never push to main.
3. Keep one observable outcome per PR, with its regression test in the same PR.
4. Open the PR as a draft and link the issue: `Fixes #n` only when it delivers the whole issue,
   `Refs #n` otherwise. Say what changed, what ran (pass or fail) and what didn't run.
5. Passing CI is not approval to merge. The owner decides, and merges to main deploy automatically.
   Never deploy, or submit real data such as Hall of Fame entries, as a test.

## Checks

| When | Run |
| --- | --- |
| While iterating | `npx vitest run <path>`, `npx tsc --noEmit -p .` |
| Before pushing | `npm run check` (lint, typecheck, all tests, set locks), once |
| Changed `src/engine` or `spec/` | also `npx vitest run src/engine` and `python3 -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json` (Python 3.13, `cryptography==50.0.1`) |
| Changed the build | also `npm run build` |
| Adding a set version | `npm run check:sets -- --update` (it refuses changes to released sets) |
| Docs only | check local links and `git diff --check origin/main...HEAD` |

CI runs `npm run check`, `npm run build` and the Python verifier on every pull request and on pushes
to branches other than main. The deploy workflow runs `npm run check` again before deploying main.
A skipped or unrun check isn't a pass; list it in the PR. Never regenerate vectors or set locks to
make a failing check pass.

Browser end-to-end, performance and agent-audit runners are proposed but don't exist yet. Until
they land, do browser or device checks by hand against the preview and describe them in the PR.
