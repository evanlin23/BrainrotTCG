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

## Proportional review & evidence routing

Every merge requires independent review approval of the exact candidate head. Evidence is chosen proportionally by change risk:

| Change Risk | Focus & Invariants | Proportional Evidence Required |
| --- | --- | --- |
| **High-Risk** (Storage, Proofs, Engine, Spec, Migrations, Workflows) | Saves safe, proof integrity, error taxonomy preserved, zero regressions | Independent counterexample test derived from user/spec contract; test mocks preserve real boundary error taxonomy and lifecycle (e.g. operational failure vs invalid proof); real startup/migration entry-point verification. |
| **Visible-Flow / UI** | Player job clarity, responsive layout, accessibility, state completeness | State the screen's player job, primary fact, and next action. Information review guard: audit repeated visible facts; choose keep/merge/demote/disclose/remove. Inspect narrow/short/enlarged text, keyboard navigation, reduced motion, and empty/loading/error states. |
| **Architecture** | Clear boundaries, lifetime safety, backward compatibility | Responsibility ownership, simpler existing alternatives, async/resource lifetime, bounded untrusted data, compatibility. No speculative abstractions. |
| **Routine / Docs** | Clarity, no dead links, style integrity | Local link checks, formatting, and `git diff --check`. No unnecessary heavy suites required. |

### Escaped-defect and review invariants
- **Never trust author self-review**: Reviewers judge independently by reading changed code and collaborating callers, not the author's summary or "tests passed".
- **Mock fidelity**: Test fixtures and mocks must preserve real boundary error taxonomy. A generic `Error('bad')` mock cannot verify whether a caller distinguishes operational failures (e.g. storage denial, network timeout) from invalid data/proofs.
- **Unresolved risk cannot be approved**: A `not checked` list is for recording items outside scope, never for waving through unresolved correctness risks. If material scope is unreviewed or critical evidence is missing, the verdict must be `changes-needed` or `block`.
- **Presentation cap**: The 5-finding cap in review reports is a formatting limit, not a pass to hide blockers. If additional blockers exist, report `changes-needed`.

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

To run actionlint locally (it is not part of `npm run check` and isn't assumed to be installed),
repeat what the `workflow-validation` job in `.github/workflows/ci.yml` does, from the repo root. Put
the download in a throwaway directory, not the checkout:

```sh
VERSION="1.7.12"
TARBALL="actionlint_${VERSION}_linux_amd64.tar.gz"
mkdir -p /tmp/actionlint && cd /tmp/actionlint
curl -fsSL -O "https://github.com/rhysd/actionlint/releases/download/v${VERSION}/${TARBALL}"
echo "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  ${TARBALL}" | sha256sum -c -
tar -xzf "${TARBALL}" actionlint
cd - && /tmp/actionlint/actionlint -shellcheck=''
```

Keep the version and hash the same as CI; a new `VERSION` needs its new hash in both places. The
tarball and hash are for Linux on x86-64 (linux_amd64), as CI uses; elsewhere use Docker, or your
platform's release asset checked against the release's published checksums. With Docker,
`docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12 -shellcheck=''` runs the same release,
but the image isn't hash-checked. Both ignore ShellCheck (`-shellcheck=''`), as CI does.

The card asset check (`npm run check:card-assets`) decodes every registered card WebP and checks
generated geometry. It covers openable pack wrappers/thumbnails, retained pack art when present,
finish thumbnails declared by the generator manifest (or present for registered cards), the
shared alpha frame mask and card back. Missing undeclared finish variants retain the existing
full-size fallback. Preview outputs and built hosting paths are outside this check.
Runtime: 5.4 s and 6.3 s over two warm runs (card files already in the OS page cache), measured
2026-10-17 in a Claude Code cloud container with 4 cores shared with other jobs.

The site check (`npm run check:site`, after a build, about 30 s) reads `dist/` with the build's
`BASE_PATH` and `SITE_URL`. Every page's local links and stylesheet `url()`s must stay under
`BASE_PATH` and be in the build, every share and set page the set registry gets must be there and
forward to `BASE_PATH`, and each page's `og:image` must be under `SITE_URL` and decode as a JPEG of
its `og:image:width`x`og:image:height`. `scripts/check-site.test.ts` covers it offline with fixtures.

Three fixture suites in `npm run check` cover the hosting and Hall of Fame contracts without a build,
a token or the network. `scripts/preview-pages.test.ts` writes the share pages (`p/`) and set pages
(`s/<id>/`, released sets only) for GitHub Pages (`/BrainrotTCG/`), Cloudflare (`BASE_PATH=/`) and
the old address after a move. It checks where each file lands, its redirect and its link-preview
tags against `index.html` and `vite.config.ts`. `scripts/hall-of-fame.test.ts` runs the `build`,
`verify-issue` and `inbox` modes against a stubbed GitHub API and relay.
`scripts/hof-intake.fixtures.test.ts` (alone: `npx vitest run scripts/hof-intake.fixtures.test.ts`)
runs the real relay reader, inbox and build against in-memory GitHub and relays
(`scripts/fixtures/hof/`): duplicates, malformed input, per-run caps, interrupted runs, `rejected`
issues and byte-identical output. Whether Discord, Slack or X
actually unfurl a page is still checked by hand, against a deployed address.

## Browser smoke

`npm run test:browser` (Playwright, Chromium) builds the checkout and owns a strict-port preview at
`http://127.0.0.1:4173/BrainrotTCG/`; stop any server on that port first (or set `PREVIEW_PORT`),
and set `BASE_PATH=/` for a root-path build. It runs the journeys in `tests/browser/` on desktop
and Pixel 5 viewports (phone-only checks skip desktop); the pack-opener smoke blocks HTTP outside
the preview origin and all WebSockets, seeds a disposable identity with muted audio, opens one real
pack and checks that stats, collection and history survive a reload. Failure traces, screenshots
and videos land in `test-results/` (uploaded by CI). `agent-audit.spec.ts` checks only the audit's
browser boundary; the agent audit itself runs locally only (see
[Local agent usability audit](#local-agent-usability-audit)). Pixel 5 emulation is not a phone: do
physical-device checks by hand against the preview and describe them in the PR.

## Local agent usability audit

Owner decision, 2026-10-17: usability audits use Claude Code only (no Codex or other providers),
driving the built site with Playwright. Results come from simulated agent reviewers in Chromium
emulation, not human newcomers or a real device, and anything that cites one says so.

`npm run audit:agent -- --task=opening --turns=12 --seconds=180` (`scripts/agent-audit/run.ts`;
boundary in docs/ARCHITECTURE.md) runs one fresh reviewer per task, one after another. Tasks are
`opening`, `sharing`, `results` and `recovery`, each limited to 30 to 180 seconds, 3 to 40 turns
(model responses) and 40 browser calls. It needs Unix, Node 22, Playwright's Chromium and Claude
Code 2.1.302 signed in (`claude auth status`). Another version, a signed-out CLI or any
instruction file a reviewer could load stops it before any agent runs, since memory would coach the
reviewer: a managed or user `CLAUDE.md` or `~/.claude/rules`, or a `CLAUDE.md`, `CLAUDE.local.md`,
`AGENTS.md` or `.claude/` memory or rules in the temporary directory or above it. A task
that hits a limit, is cancelled, or starts with missing or extra tools is recorded as unrun with
the reason, never as passed. It is not part of `npm run check` or CI; unit tests use a fake CLI.

Each reviewer is started with these flags, all listed by `claude --help` in 2.1.302 (`claudeArgs`
in `scripts/agent-audit/claude.ts`): `-p --restricted --tools "" --strict-mcp-config --mcp-config
<audit server> --allowed-tools <mcp__audit__ snapshot, click, press, wait> --permission-mode dontAsk
--disable-slash-commands --no-chrome --no-session-persistence --output-format stream-json --verbose
--json-schema <report> --system-prompt <reviewer rules> <task sentence>`. That leaves no Bash, Edit,
Write, web or other built-in tools, no user, project or local settings files or their hooks
(managed settings still apply), no skills, slash commands or other MCP servers, and an empty
temporary working directory. The task sentence from `contracts.ts` is the only user prompt: no
source, docs, history or hints, since coaching would test the coach, not the page. The coordinator
prompt in `contracts.ts` is separate and goes only into the report. 2.1.302 has no turn flag, so the
runner counts responses and stops the process group when the cap is passed; it also stops if the
session reports any tool outside the allowlist. To move the pin, re-check every flag in
`claude --help` first, then update `claudeVersion`.

Recorded runs, 2026-10-17, revision e993944, in a cloud container: base `/BrainrotTCG/`, Chromium 156
at 393x727 with touch and reduced motion, external requests blocked, model claude-opus-5-5.

- `opening`, 12 turns, 180 s: completed in 11 turns and 13 browser calls. It opened a pack, flipped
  all five cards and reached the summary. Observation: after "Open pack" the button disables while
  the wrapper and "Swipe across to open" stay for about a second, so it looked like the click had
  failed. The browser logged one page error (not yet reproduced).
- `opening`, 3 turns, 60 s: unrun, "turn budget exhausted" after 3 browser calls (the expected
  incomplete case).

Not run: the other three tasks, and a signed-out or missing CLI with the real runner (covered by the
fake-CLI tests). Screen readers, native share and a physical phone are out of scope.

When to audit: before a release, and for any change to a player flow (opening, sharing, recovery,
settings or first run), with the tasks that flow touches. Trivial copy or style edits don't need
one. After fixes, rerun the affected tasks, each in a fresh task-only session: the reviewer gets
the task sentence alone, with no notes, observations or hints from the earlier run.

Using the results:

1. Run from a clean commit; the runner refuses tracked edits and untracked `src/` or `public/`
   files. Never point it at a real save, key or identity, and never post, merge or deploy from it.
2. The coordinator reproduces each observation on the same revision, separates blocked tasks from
   product defects, dedupes against open issues, and retests a fix with a fresh reviewer. Only
   reproduced findings go into an issue or PR.
3. The write-up gives the revision, conditions, task outcomes and what could not be checked. One
   agent's result is an observation, not a rate.

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
measured opening mines a real ticket. Three runs is the default; `PERF_REPETITIONS=7 npm run
test:performance` (an integer from 1 to 50) takes a larger sample by hand, and the global timeout
grows with it (4 minutes per repetition). The report records the count.

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
the live ticket's mining time. It also records the page's main thread between the press and the
decoded cards: long tasks (over 50 ms, with their count, total and longest) and animation-frame gaps
(frames, the longest gap, gaps over 50 ms). Ticket jobs per worker, workers created and peak busy are
counted in the page; the Argon2 figure is peak busy × `TICKET_PARAMS.memorySize`, an estimate kept apart from
the measured main-target heap. Reports go to
`test-results/performance-optional-work/`. It's **desktop-Chromium emulation, not real-device
evidence** (#8): CDP's CPU slowdown doesn't throttle workers, and the pool size follows the emulated
navigator. `npx vitest run tests/performance/optional-work.test.ts` checks its report.

### Proposed budgets (not enforced)

**No fail-on-regression gate exists.** Both harnesses set `timingGate: false`, nothing in
`npm run check` or PR CI runs them, and the Actions job only uploads reports. These budgets are
proposals for a reviewer to hold a change against, taken from one n=7 sample (Chromium emulation,
393×727, 4× CPU, 10/2 Mbps and 40 ms, a 4-vCPU 2.1 GHz Xeon host; **not a real device**). Timing
budgets are about 1.5× the highest median seen, so machine noise doesn't trip them. Sizes and counts
were identical on every run, so theirs are tight: the cold transfer sits about 10% over, and the few
warm kilobytes get a round 10,000 B.

**Provenance: the app under test was `8e81f18`, the harness was not.** The sample ran on a tree
based on `8e81f18` with uncommitted changes to tracked files (the optional-work reports say
`trackedSourceDirty: true`), and the exact uncommitted state wasn't kept, so `8e81f18` alone doesn't
reproduce every row. Those changes are now committed: the `PERF_REPETITIONS` setting that made n=7
possible (`tests/performance/report.ts`; the default stays 3), and the optional-work harness's
main-thread recording of long tasks and frame gaps (`tests/performance/optional-work.spec.ts` and
`optional-work.ts`). Rows marked † exist only because of that recording. The other rows come from
code `8e81f18` already had (`baseline.spec.ts` is unchanged since, and so are the optional-work worker
counts and open-to-result timings). The sample has not been re-measured on the committed harness,
and the pack layout change of #536 landed after `8e81f18`, so it is not in these numbers either.

| Metric | Median (min to max), n=7 | Proposed budget |
| --- | --- | --- |
| Cold load to clickable, 0 / 100 history records | 2107 (2018 to 2151) / 2125 (2051 to 2443) ms | 3200 ms |
| Warm load to clickable, 0 / 100 records | 1742 (1659 to 1930) / 1717 (1622 to 2220) ms | 2600 ms |
| Open to decoded result, all four scenarios | 2192 to 2319 ms (slowest run 2597) | 3500 ms |
| Cold encoded transfer, 0 / 100 records | 1,454,287 / 1,576,319 B | 1,750,000 B |
| Warm encoded transfer (304 revalidations) | 4954 / 5081 B | 10,000 B |
| Workers created for one opening | 1 | 1 |
| Cold long-task total | 1311 / 1352 ms (slowest run 1600) | 2000 ms, a review flag |
| Optional work active: workers, Argon2 peak estimate | 4 workers, 96 MiB (inactive: 1, 32 MiB) | 4, 96 MiB |
| Optional work active vs idle, open to result | 2467 vs 2084 ms (1.18×); an earlier pass 2816 vs 2214 ms (1.27×) | within 1.5× of idle |
| † Optional work active vs idle, long tasks while opening | 747 vs 651 ms total, longest 384 vs 364 ms | a review flag |
| † Optional work active vs idle, frame gaps over 50 ms while opening | 7 vs 5 (longest gap 383 vs 367 ms) | a review flag |

Maximum frame interval (317 to 417 ms median) has no budget: at 4× slowdown it is the ticket and
decode work on the main thread, and only a real phone can say what players see. A gate, if one is
added, should fail only on the deterministic rows (transfer, worker count, Argon2 estimate); the
timing rows stay review flags until #8 has real-device numbers, so a noisy runner can't block
unrelated work. Compare only against a run on the same machine and settings.

### Ticket cost (opt-in)

`npx tsx scripts/benchmark-ticket.ts [runs]` (default 7) times the real `computeTicket` with the
shipped `TICKET_PARAMS` in Node and on the main thread of a blank Chromium page at 1× and 4× CPU
(#36). It reads and writes no save, history or network, uses a fixed throwaway key, and never
changes the parameters. CDP's slowdown doesn't reach workers, so the 4× figure mines on the main
thread; the app mines in a worker. One run on the same host as above, n=7 after the first call (which
also starts the WASM): in Node (no browser, no network) 112 (104 to 132) ms; on the main thread of a
blank Chromium page at 390×844, device scale 3, mobile emulation and no network, at 1× CPU 88 (81 to
135) ms and at 4× CPU 494 (436 to 554) ms. The script was still an untracked file on a tree based on
`8e81f18` (so no report could flag it as dirty); it is committed now, and the code it times
(`src/engine`, the ticket worker in `src/workers`, `spec`) is identical between `8e81f18` and this
branch. **Chromium emulation, not a real device**; a low-end phone and a GPU or ASIC miner haven't
been measured.

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
