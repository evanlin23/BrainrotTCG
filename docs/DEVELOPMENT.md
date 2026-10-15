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
| Before pushing | `npm run check` (lint, typecheck, all tests, set locks, card assets), once |
| Changed `src/engine` or `spec/` | also `python3 -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json` (Python 3.13, `cryptography==50.0.1`) |
| Changed the build | also `npm run build` |
| Changed UI, storage or the build | also `npm run test:browser` (see Browser smoke) |
| Adding a set version | `npm run check:sets -- --update` (it refuses changes to released sets) |
| Docs only | check local links and `git diff --check origin/main...HEAD` |

CI runs `npm run check`, `npm run build`, the Python verifier, the browser smoke and actionlint on
every pull request and on pushes to branches other than main. The deploy workflow runs the verifier
and `npm run check` again before deploying main.
A skipped or unrun check isn't a pass; list it in the PR. Never regenerate vectors or set locks to
make a failing check pass.

The card asset check (`npm run check:card-assets`) decodes every registered card WebP and checks
generated geometry. It covers openable pack wrappers/thumbnails, retained pack art when present,
finish thumbnails declared by the generator manifest (or present for registered cards), the
shared alpha frame mask and card back. Missing undeclared finish variants retain the existing
full-size fallback. Preview outputs and built hosting paths are outside this check.

Two fixture suites in `npm run check` cover the hosting and Hall of Fame contracts without a build,
a token or the network. `scripts/preview-pages.test.ts` writes the share pages (`p/`) and set pages
(`s/<id>/`, released sets only) for GitHub Pages (`/BrainrotTCG/`), Cloudflare (`BASE_PATH=/`) and
the old address after a move. It checks where each file lands, its redirect and its link-preview
tags against `index.html` and `vite.config.ts`. `scripts/hall-of-fame.test.ts` runs the `build`,
`verify-issue` and `inbox` modes against a stubbed GitHub API and relay. Whether Discord, Slack or X
actually unfurl a page is still checked by hand, against a deployed address.

## Browser smoke

`npm run test:browser` (Playwright, Chromium) builds the checkout and owns a strict-port preview at
`http://127.0.0.1:4173/BrainrotTCG/`; stop any server on that port first, and set `BASE_PATH=/` for
a root-path build. It blocks HTTP outside the preview origin and all WebSockets, seeds a disposable
identity with muted audio, opens one real pack on desktop and Pixel 5 viewports, and checks that
stats, collection and history survive a reload. Failure traces, screenshots and videos land in
`test-results/` (uploaded by CI). It covers that one journey only: agent-audit and physical-device
checks don't exist yet, so do those by hand against the preview and describe them in the PR.

## Mounted integration tests

`src/test/mountedApp.ts` mounts the real `App` in jsdom: StrictMode, migrations, the memory-only
pack store, fake timers fixed at 2026-01-01, and a simulated ticket Worker that runs the real
Argon2 computation. It blocks and records fetch, WebSocket, XHR, `window.open`, beacons and form
submits. Use it for a regression that needs the whole app across interactions or a reload (a pack
opening, collection recovery, save warnings). Keep plain unit tests for single functions, and the
browser smoke for real rendering, images, IndexedDB and Workers, which jsdom can't show.

A bug PR adds its regression as `src/test/<topic>.integration.test.ts`, with the same
`@vitest-environment` and `@vitest-environment-options` header lines as the existing files. Each
test owns its fixture: it seeds only a disposable player and the settings it needs (never a real
save), drives the UI with `interact()`, waits for one observable outcome with
`until(description, assertion)`, and claims expected console errors with `takeErrors()`.
`dispose()` in `afterEach` fails on any other error, warning or I/O and restores storage, timers,
globals and modules. Run one with
`npx vitest run src/test/packLifecycle.integration.test.ts`; `npm test` runs them all.

## Performance baseline

`npm run test:performance` is **report-only**: timings have no pass/fail budget, and neither
`npm run check` nor PR CI runs it. Run it by hand, or from the manual "Performance Baseline (report
only)" Actions job (read-only, 20-minute cap, reports kept seven days). It reuses the browser smoke's
build and server, disposable identity, HTTP/WebSocket guards and opening/record/reload assertions,
so functional errors still exit nonzero and never enter the timing summaries.

It runs two cold-HTTP-cache scenarios, three times each, in one headless Chromium at 393×727 with
CDP 4× CPU slowdown and a 10/2 Mbps, 40 ms network: a fresh save, and 100 synthetic cached history
records. That history repeats known cards at synthetic nonces; it isn't verified history, a valid
profile or proof evidence. Each measured opening mines a real ticket. Worker HTTP egress is probed;
Worker WebSockets aren't proven blocked. Warm-cache runs are still open (#351).

`test-results/performance/raw-runs.json` and `summary.json` record the commit and dirty state,
runner, browser and host, every raw run, and median/min/max per scenario; each report lists its
own metric limits. **It isn't real-phone evidence**: page-level CDP throttling doesn't throttle
workers the same way or emulate phone RAM, GPU, touch or a physical device, and the heap figure
covers the main JS target only. Compare runs only on the same machine, browser, settings and
recorded revision, never against the deployed site. `npx vitest run tests/performance/report.test.ts`
checks the report schema, and this must exit nonzero with zero timing samples:
`PERF_INJECT_FUNCTIONAL_FAILURE=1 npm run test:performance -- --grep 'first-cold / 1' --output=test-results/performance-failure --max-failures=1`.

## Dependency audit

When the lockfile changes, run `npm audit` and `npm audit --omit=dev`. The findings, their exposure
and dispositions are in [DEPENDENCY_ADVISORIES.md](DEPENDENCY_ADVISORIES.md). Never use
`npm audit fix --force`.

Dependabot (`.github/dependabot.yml`) is the only update bot. Root npm minor and patch updates
arrive as two grouped PRs, `dev-tooling` (devDependencies) and `prod` (dependencies), and GitHub
Actions minor and patch updates as one `github-actions` PR. `hash-wasm` and `@noble/*` are left out
of `prod` and arrive as separate PRs, because they can change pack and proof derivation. Majors and
`tools/wrangler` updates stay one PR per package. By policy (not enforced by the config), each
update PR gets a review and green CI before it merges.
