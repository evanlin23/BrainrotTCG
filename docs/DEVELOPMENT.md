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
| Before pushing | `npm run check` (lint, typecheck, all tests within the test budgets, set locks, card assets), once |
| Changed `src/engine` or `spec/` | also `python3 -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json` (Python 3.13, `cryptography==50.0.1`) |
| Changed the build or link previews | also `npm run build && npm run check:site`, and the same with `BASE_PATH=/ SITE_URL=https://brainrottcg.pages.dev/` |
| Changed UI, storage or the build | also `npm run test:browser` (see Browser smoke) |
| Adding a set version | `npm run check:sets -- --update` (it refuses changes to released sets) |
| Docs only | check local links and `git diff --check origin/main...HEAD` |

CI runs `npm run check`, `npm run build` and `npm run check:site` for both base paths, the Python verifier, the browser smoke, actionlint and the
deploy contract test (`python3 scripts/deploy_contract_test.py`) on every pull request and on pushes
to branches other than main. The deploy workflow runs the verifier and `npm run check` again before
deploying main. CI uploads files only from failed runs, kept for 7 days.
A skipped or unrun check isn't a pass; list it in the PR. Never regenerate vectors or set locks to
make a failing check pass.

The card asset check (`npm run check:card-assets`) decodes every registered card WebP and checks
generated geometry. It covers openable pack wrappers/thumbnails, retained pack art when present,
finish thumbnails declared by the generator manifest (or present for registered cards), the
shared alpha frame mask and card back. Missing undeclared finish variants retain the existing
full-size fallback. Preview outputs and built hosting paths are outside this check.

The site check (`npm run check:site`, after a build, about 30 s) reads `dist/` with the build's
`BASE_PATH` and `SITE_URL`. Every page's local links and stylesheet `url()`s must stay under
`BASE_PATH` and be in the build, every share and set page the set registry gets must be there and
forward to `BASE_PATH`, and each page's `og:image` must be under `SITE_URL` and decode as a JPEG of
its `og:image:width`x`og:image:height`. `scripts/check-site.test.ts` covers it offline with fixtures.

Two fixture suites in `npm run check` cover the hosting and Hall of Fame contracts without a build,
a token or the network. `scripts/preview-pages.test.ts` writes the share pages (`p/`) and set pages
(`s/<id>/`, released sets only) for GitHub Pages (`/BrainrotTCG/`), Cloudflare (`BASE_PATH=/`) and
the old address after a move. It checks where each file lands, its redirect and its link-preview
tags against `index.html` and `vite.config.ts`. `scripts/hall-of-fame.test.ts` runs the `build`,
`verify-issue` and `inbox` modes against a stubbed GitHub API and relay. Whether Discord, Slack or X
actually unfurl a page is still checked by hand, against a deployed address.

## Browser smoke

`npm run test:browser` (Playwright, Chromium) builds the checkout and owns a strict-port preview at
`http://127.0.0.1:4173/BrainrotTCG/`; stop any server on that port first (or set `PREVIEW_PORT`),
and set `BASE_PATH=/` for a root-path build. It runs the journeys in `tests/browser/` on desktop
and Pixel 5 viewports (phone-only checks skip desktop); the pack-opener smoke blocks HTTP outside
the preview origin and all WebSockets, seeds a disposable identity with muted audio, opens one real
pack and checks that stats, collection and history survive a reload. Failure traces, screenshots
and videos land in `test-results/` (uploaded by CI). `agent-audit.spec.ts` checks only the audit's
browser boundary; the newcomer agent audit itself (`npm run audit:agent`, see
docs/ARCHITECTURE.md) runs locally only. Pixel 5 emulation is not a phone: do physical-device
checks by hand against the preview and describe them in the PR.

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

## Test budgets

`npm test`, and so `npm run check` and CI, runs the suite once with V8 coverage and enforces two
budgets, checked in this order:

| Budget | Baseline (October 2026, 798 tests) | Enforced | Set in |
| --- | --- | --- | --- |
| Wall time of the whole run | 61.9-64.9 s with coverage, 57.4-64.4 s without, on a shared 4-core container; 53.5-62.7 s on CI without | at most 150 s | `RUNTIME_BUDGET_SECONDS` in `scripts/test-budget.ts` |
| Coverage of `src/` app code, excluding tests, `src/test/` helpers and `.d.ts` | branches 78.2%, statements 81.8%, lines 83.5% | at least branches 75%, statements 78%, lines 80% | `test.coverage.thresholds` in `vite.config.ts` |

After the test summary, and before the coverage summary, the run prints
`Test budget: N tests in M files took Xs (budget 150s)`, and it fails only past the budget. The
runtime budget holds for every `npm test` run, whatever flags follow `--`: the `testBudget()` plugin
in `vite.config.ts` adds its reporter after `--reporter` flags replace the configured ones, so
`npm test -- --reporter=dot` keeps it, and `npm test -- --coverage.enabled=false` drops only the
floors. Targeted `npx vitest run <path>` runs skip both budgets; adding `--coverage` to one turns
the floors on, and a partial run won't meet them. The baseline came from three runs each of `vitest run` and
`npm test` plus recent CI runs. Coverage stayed within 0.05 points between runs and added up to
20% wall time, so it rides in the one test run. Instrumentation makes the CPU-bound engine
simulations about 3x slower; under heavy load one run took 100 s and two of them passed the 5 s
default timeout, so `npm test` passes `--testTimeout=15000`.

The floors sit 3-4 points below the baseline and the runtime budget about 2.4x above it, so
ordinary work, a large UI refactor included, shouldn't trip them. To move one, run `npm test` three
times on an up-to-date branch, set each floor a few points below the lowest figure and the runtime
budget to about twice the slowest run, and give the old and new numbers in the PR. Lower a floor
only for removed or unreachable code, never to land untested code. When the runtime budget trips,
look for a slow or hanging test before raising it.

## Performance baseline

`npm run test:performance` is **report-only**: timings have no pass/fail budget, and neither
`npm run check` nor PR CI runs it. Run it by hand, or from the manual "Performance Baseline (report
only)" Actions job (read-only, 20-minute cap, reports kept seven days). It reuses the browser smoke's
build and server, disposable identity, WebSocket guard and opening/record/reload assertions, so
functional errors still exit nonzero and never enter the timing summaries. Cold runs also reuse its
HTTP guard. Playwright routing disables the HTTP cache, so warm runs guard HTTP with a page-target
CDP Fetch guard instead and fail if any other page opens.

It runs a fresh save and 100 synthetic cached history records, three times each, in one headless
Chromium at 393×727 with CDP 4× CPU slowdown and a 10/2 Mbps, 40 ms network: cold (HTTP cache
cleared and disabled), then warm (the same journey again in the same context after an unthrottled
priming load, keeping the HTTP cache and IndexedDB, with localStorage reset). That history repeats
known cards at synthetic nonces; it isn't verified history, a valid profile or proof evidence. Each
measured opening mines a real ticket.

Limits: `vite preview` sends `Cache-Control: no-cache`, so warm loads are 304 revalidations, not
cache hits without a request. The IndexedDB pack cache stays empty in this journey, because it only
stores re-opened packs. Worker HTTP egress is probed, but Worker WebSockets aren't proven blocked.

`test-results/performance/raw-runs.json` and `summary.json` record the commit and dirty state,
runner, browser and host, every raw run, and median/min/max per scenario; each report lists its
own metric limits. **It isn't real-phone evidence**: page-level CDP throttling doesn't throttle
workers the same way or emulate phone RAM, GPU, touch or a physical device, and the heap figure
covers the main JS target only. Compare runs only on the same machine, browser, settings and
recorded revision, never against the deployed site. `npx vitest run tests/performance/report.test.ts`
checks the report schema, and this must exit nonzero with zero timing samples:
`PERF_INJECT_FUNCTIONAL_FAILURE=1 npm run test:performance -- --grep 'first-cold / 1' --output=test-results/performance-failure --max-failures=1`.

### Optional work (opt-in)

`npm run test:performance:optional-work` (report-only, in no check or CI job) times the same
throttled opening with optional work idle and active (#342): 24 synthetic records, then the same
records without their cards and an unfinished re-open, so the app re-mines them in the background.
It presses once the live ticket is ready, so both time the same opening; it records press to summary
and to decoded summary (optional work is held until the summary's cards decode, 2 s at most), plus
the live ticket's mining time. Ticket jobs per worker, workers created and peak busy are counted in
the page; the Argon2 figure is peak busy × `TICKET_PARAMS.memorySize`, an estimate kept apart from
the measured main-target heap. Reports go to
`test-results/performance-optional-work/`. It's **desktop-Chromium emulation, not real-device
evidence** (#8): CDP's CPU slowdown doesn't throttle workers, and the pool size follows the emulated
navigator. `npx vitest run tests/performance/optional-work.test.ts` checks its report.

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
