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
5. A merge needs a reviewer's approval of the head and green CI on a branch that is up to date with
   main. Only the owner approves new card sets or removing a set's draft flag. Merges to main deploy
   automatically. Never deploy, or submit real data such as Hall of Fame entries, as a test.

## Checks

| When | Run |
| --- | --- |
| While iterating | `npx vitest run <path>`, `npx tsc --noEmit -p .` |
| Before pushing | `npm run check` (lint, typecheck, all tests, set locks), once |
| Changed `src/engine` or `spec/` | also `python3 -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json` (Python 3.13, `cryptography==50.0.1`) |
| Changed the build | also `npm run build` |
| Changed UI, storage or the build | also `npm run test:browser` (see Browser smoke) |
| Adding a set version | `npm run check:sets -- --update` (it refuses changes to released sets) |
| Docs only | check local links and `git diff --check origin/main...HEAD` |

CI runs `npm run check`, `npm run build`, the Python verifier and the browser smoke on every pull
request and on pushes to branches other than main. The deploy workflow runs `npm run check` again before deploying main.
A skipped or unrun check isn't a pass; list it in the PR. Never regenerate vectors or set locks to
make a failing check pass.

## Browser smoke

`npm run test:browser` (Playwright, Chromium) builds the checkout and owns a strict-port preview at
`http://127.0.0.1:4173/BrainrotTCG/`; stop any server on that port first, and set `BASE_PATH=/` for
a root-path build. It blocks HTTP outside the preview origin and all WebSockets, seeds a disposable
identity with muted audio, opens one real pack on desktop and Pixel 5 viewports, and checks that
stats, collection and history survive a reload. Failure traces, screenshots and videos land in
`test-results/` (uploaded by CI). It covers that one journey only: performance, agent-audit and
physical-device checks don't exist yet, so do those by hand against the preview and describe them
in the PR.
