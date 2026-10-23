# Development and verification

Workflow and checks for contributors. Repo rules (layers, compatibility, saves) are in
[CLAUDE.md](../CLAUDE.md); domain contracts are in [ARCHITECTURE.md](ARCHITECTURE.md),
[PULL_SPEC.md](../spec/PULL_SPEC.md), [ADDING_A_SET.md](ADDING_A_SET.md) and [DESIGN.md](DESIGN.md).
If this page disagrees with `package.json` or `.github/workflows/`, those win.

## Setup

Use Node 22, as CI does. `npm ci` installs from the lockfile; only change `package-lock.json` in a
dependency change. A fresh checkout or worktree has no `node_modules` and needs `npm ci` before any
check (the Claude Code SessionStart hook `.claude/hooks/install-deps.sh` runs it when the folder is missing). When a subagent stops, the SubagentStop hook
`.claude/hooks/clean-agent-worktree.sh` deletes `node_modules`, `dist`, `playwright-report` and
`blob-report` (not `test-results`, which holds evidence other agents read) from its
`.claude/worktrees/agent-<id>` worktree unless a process still runs there, so finished worktrees
don't fill the disk. `npm run dev` starts the app; `npm run build && npm run preview` serves the built site.

A full clone is about 230 MiB. [REPO_SIZE.md](REPO_SIZE.md) has a blobless, sparse recipe (52-54 MiB
of `.git` plus about 58 MiB of working tree on disk, in about 3 s) that skips the PNG source art. Without
it, `npm run cards` can't run and `npm run check` can't test for placeholder art, so CI is authoritative;
run `git sparse-checkout disable` before editing or adding a set.

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

## Review evidence

The reviewer (`.claude/agents/reviewer.md`) picks evidence from the diff, by risk, and records the
head, the evidence checked and remaining risks. Missing required evidence is `changes-needed` or an
external blocker, never an implied pass. Don't trust the author's summary.

| Change | Evidence |
| --- | --- |
| Docs, low risk | Links and `git diff --check`. |
| Behaviour, storage, proof, engine, spec, migration, workflow | A counterexample from the contract, independent of the author's tests. Mocks keep the real boundary's types, error kinds and lifecycle. Migrations: the real startup entry. |
| Visible flow | Player problem, observable acceptance, the screen's job, primary fact and next action. Empty, loading and error states; fit with existing navigation, components and tokens. Narrow, short and enlarged text, keyboard, reduced motion as relevant. Repeated facts: keep, merge, demote, disclose or remove. A screenshot or test count alone isn't approval. |
| Architecture, public-resource growth | Responsibility owner, simpler existing option, async and resource lifetime, bounded untrusted data, compatibility. No speculative frameworks. |

The reviewer can't render the PR. For a visible flow, the implementer gives bounded, sanitized
before/after observations on the exact head, using the [DESIGN.md](DESIGN.md) rules and, for a
meaningful flow change, [`npm run audit:agent`](#local-agent-usability-audit). Tests must be
deterministic: reviewers block fixed sleeps, timing-dependent waits, and retries or skips a PR adds.

## Defect learning and issue closure

Closing a reproduced defect takes a short note on the issue, backed by the PR's final-head evidence
(the evidence tiers above apply):

1. **Root cause**, one sentence naming the code or contract that failed. Separate a pre-existing
   defect from a regression this change introduced. Cite source, test or PR evidence; don't name the
   introducing commit without tracing it.
2. **Escape class**, why existing controls missed it. Cite the test or PR that missed it:
   - *missing_scenario*: an edge, cancellation, storage denial or limit was never exercised.
   - *incorrect_expected_contract*: a test asserted the wrong behaviour or merged two failure kinds.
   - *over_mocked_collaborator*: a mock hid the real boundary (the Review evidence row covers what
     mocks must keep).
   - *wrong_test_level*: the defect lives at a boundary or startup entry that only unit tests touched.
   - *stale_evidence*: results came from an earlier head, or a failure was skipped.
   - *missing_release_decision*: a deferral or specification gap nobody owned.
3. **Regression test** at the lowest useful level, asserting observable behaviour. Show it fails on
   the faulty behaviour and passes on the fix. Say whether it runs in a real browser or against an
   injected boundary. Add the storage-denial, cancellation or resource-limit cases only where the
   defect calls for them. A setup failure or skip isn't a detected failure.
4. **Sibling scan**: search directly related paths for the same failure class. Link an existing issue
   or file a bounded follow-up; don't widen the fix PR. If a durable invariant (guard, validation
   boundary or fixture) would prevent recurrence, even for a first-time defect, name one small
   verifiable prevention action with its canonical owner and link the existing check or issue. Don't
   add overlapping tests. A recurring defect gets that task instead of another local patch.
5. **Pending external checks** (physical device, external API) stay marked pending.

Examples from merged fixes:

- #647 (PR #912), `wrong_test_level`: the Settings import (FileReader) boundary dereferenced parsed
  JSON before checking it was an object. Before 1209cf0 only `null` threw (`incoming.player`);
  arrays and primitives reached the "Replace <saves>? Yours is kept as a backup." prompt (asked only
  when this browser already has progress). The regression
  is in `SettingsPage.test.tsx` (non-object files give a message and no replacement prompt).
- #695 (PR #919), `missing_scenario`: `reopenCache.ts` `flush` ran `removeItem` inside its `catch`,
  so a fully denied storage threw from a timer. The regression is in `reopenCache.test.ts` (both
  `setItem` and `removeItem` fail).
- #1129 (PR #1132), `missing_scenario`: from 1200 to 1399px wide the desktop logo came to 58.5px, so
  the header was 85.5px tall and the pack stage started on a half pixel. The stage's fade then
  rounded the swipe chip's edges either way from run to run, and the first-pack baseline failed
  intermittently by 1px. Nothing checked where layout lands, only the pixels. The prevention is a
  whole-pixel logo size (`round()` in `index.css`) and `tests/browser/stage-pixel.spec.ts`, which
  fails wherever a desktop window puts the stage off a whole pixel.

## Checks

| When | Run |
| --- | --- |
| While iterating | `npx vitest run <path>`, `npx tsc --noEmit -p .` |
| Before pushing | `npm run check` (lint, import boundaries, typecheck, all tests within the test budgets, set locks, card assets), once |
| Changed `src/engine` or `spec/` | also `python3 -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json` (Python 3.13, `cryptography==50.0.1`) |
| Changed the build or link previews | also `npm run build && npm run check:site`, and the same with `BASE_PATH=/ SITE_URL=https://brainrottcg.pages.dev/` |
| Changed UI, storage or the build | also `npm run test:browser` (see Browser smoke) |
| Changed what a baselined screen shows | `npm run test:visual` in the pinned image (see Visual baselines) |
| Changed the logo mark (`src/styles/logoMark.ts`) | `npm run icons` rewrites the logo SVGs, favicon and touch icon; `scripts/logo-icons.test.ts` fails if they drift |
| Adding a set version | `npm run check:sets -- --update` (it refuses changes to released sets) |
| Docs only | check local links and `git diff --check origin/main...HEAD` |

CI runs `npm run check`, `npm run build` and `npm run check:site` for both base paths, the Python
verifier, the browser smoke, actionlint and the deploy contract test (`python3
scripts/deploy_contract_test.py`) on every pull request and on pushes to branches other than main.
In `ci.yml`, `npm run check` runs as four parallel stage jobs, each with its own result and time:
`lint-and-types` (lint, import boundaries, both typechecks), `unit-tests` (`npm test` with coverage,
then the escaped-defect replay), `content-checks` (set locks, card assets, old vectors and locks)
and `build-and-site` (both builds and site checks). The required `check` job is their gate: it runs
even after a failure or cancellation and passes only when all four succeeded.
`scripts/ci-stages.test.ts` fails if a stage drops or changes a part of `npm run check`, or a job is
left out of the gate. Locally, `npm run check` stays the one command. The deploy workflow runs the
verifier and `npm run check` again before deploying main. CI uploads files only from failed runs,
kept for 7 days. A nightly workflow, not part of PR CI, runs the unit suite in shuffled order twice
(see Shuffled and repeat runs). A skipped or unrun check isn't a pass; list it in the PR. Never
regenerate vectors or set locks to make a failing check pass.

Rough wall times: `npm run check` about 2 min, a cold `npm run build` about 2 min, and one browser spec
file about 3 min including its build. Give these commands a 5-minute timeout or run them in the background.

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

### Import boundaries

`npm run check:imports` (part of `npm run check`) enforces the layers in
[ARCHITECTURE.md](ARCHITECTURE.md). The map is `ALLOWED_LAYERS` in
[`scripts/check-import-boundaries.ts`](../scripts/check-import-boundaries.ts): each layer lists the
layers its non-test files may import, and everything else fails with the file, line and import. In
short, `src/engine` imports nothing from another layer and only `hash-wasm` and `@noble/*` from
outside, `src/game` never imports `components`, `hooks` or `App`, `hooks` never import `components`,
`components` never import `App`, and `scripts` import engine, game, content and style code but never
UI. The check reads every `src/` and `scripts/` file with TypeScript's import scanner, so
`import type`, `export ... from` (a barrel is checked as the file it is), `import()` and tsconfig
`paths` aliases count. Test files (`*.test.*`, `src/test/`, `tests/`) may cross layers, but
production code can't import them. A new directory under `src/` fails until it is added to the map.

Within a layer, `FILE_ORDER` in the same file lists chains of files that build on each other in one
direction: a file may import the files before it in its chain, never one after it. The one chain is
the own-profile code in `src/game` (#699): `myTickets.ts` (the ticket list), then `packCache.ts`
(reading saved packs), `reopenJob.ts` (re-opening) and `profiles.ts` (proofs and stats). Every path
in a chain must name a source file, so renaming one fails the check until the chain is updated.

UI packages (`react`, `react-dom`, `framer-motion`, `lucide-react`, `canvas-confetti`) are allowed only
in `hooks`, `components`, `app` and `scripts` (scripts never import UI code anyway); `engine` allows a
fixed list of packages, and `content`, `constants`, `styles`, `data`, `workers`, `game`, `types` and `utils`
allow none.

An exception (`EXCEPTIONS` in the same file) names one file's import of one target, a repo file or a
package such as `react`, and needs a reason, an owner issue and a removal condition. `typeOnly: true`
limits it to a type import (`import type`, or `import { type X }` for every name): a run-time import of
the same target still fails. It fails the check once the import is gone, so remove the entry in the PR
that fixes the import. There is no wildcard or per-directory exception. There are no current
exceptions (the list is empty).

`src/engine` also has ESLint rules for browser globals (`window`, `document`, storage, `fetch`,
`XMLHttpRequest`, `Worker` and so on), including `globalThis.<name>` and `self.<name>`. An alias such as
`const g = globalThis; g.localStorage` or a bracket lookup still gets past them.

Not covered: browser globals and DOM types used without an import outside `src/engine`,
`import.meta.glob`, and import cycles between layers that allow each other (`game` and `utils`, `game`
and `types`). It doesn't measure file size or complexity.

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
its `og:image:width`x`og:image:height`. It also holds `index.html` and the code and styles it loads up
front to `MAX_FIRST_LOAD_BYTES` gzipped (#776): what a first visit downloads before the pack can show.
`scripts/check-site.test.ts` covers it offline with fixtures.

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

### Intake capacity harness (offline)

`npx tsx scripts/hof-capacity.ts` runs the real `inbox()` for many scheduled runs against the same
in-memory fakes, to see backlog, age and API calls under bursts, backlogs and outages, with the
shipped caps (300 attempts and 20 filings a run, paging, the 7-day window, the seen cache). It sends
nothing to GitHub, a relay or Pages. What is real and what is not:

- Ticket verification is **stubbed** (two pre-mined stand-in tickets); proof and event signatures are
  real. Time is a **fake clock** in model seconds (nothing sleeps). Run times are **modeled**:
  derivations x a small real Argon2 sample (`--argon-samples`, default 3) plus requests x placeholder
  latencies. They are not observed production throughput; timing under `timing` is report-only.
- Inputs per scenario: arrival phases, cadence, duplicate, invalid and qualifying fractions, relay
  retention, relay or GitHub outages, write limits or failures, existing issues, seen-cache filler,
  modeled costs and the bounds (events, runs, wall time, heap). Hitting a bound ends the scenario with
  `exit: aborted: ...` and fails a check. Window or retention expiry is counted apart from delivery.
- Limits, also in the report's `labels.limits`: the published list is assumed to be a 404, so the
  floor and `joinRefusal` paths do not run; event and proof keys come from 16-key pools. A scenario
  asking for a `measured` Argon2 time without a sample reports `meta.argon.source` as
  `measured-missing` and uses the default. Per run, `beyondPaging` counts in-window events the run
  didn't read (past the paging cap; since #999, only ones an earlier run already read through), and `unreadable` counts in-window events no relay could serve (every relay down).

```
npx tsx scripts/hof-capacity.ts --list
npx tsx scripts/hof-capacity.ts [--scenario name]... [--seed text] [--out report.json]
npx tsx scripts/hof-capacity.ts --include-slow          # also paging-cap, a minute or two
npx tsx scripts/hof-capacity.ts --scenario synthetic-30-packs-per-second --include-synthetic-225
```

The default scenarios take about a minute. The report holds the seed, config, runner metadata and the
raw per-run summaries; it exits 1 if a deterministic check or bound fails. The 30 packs/second
scenario is #225's synthetic future opt-in, not a claim the service supports it, and needs its flag.
`scripts/hof-capacity.test.ts` (`npx vitest run scripts/hof-capacity.test.ts`) covers small versions.

## Browser smoke

`npm run test:browser` (Playwright, Chromium) builds the checkout and owns a strict-port preview at
`http://127.0.0.1:4173/BrainrotTCG/`; stop any server on that port first (or set `PREVIEW_PORT`),
and set `BASE_PATH=/` for a root-path build. It runs the journeys in `tests/browser/` on desktop
and Pixel 5 viewports (phone-only checks skip desktop); the pack-opener smoke blocks HTTP outside
the preview origin and all WebSockets, seeds a disposable identity with muted audio, opens one real
pack and checks that stats, collection and history survive a reload. The save-move smoke runs its own
Vite dev server (with `VITE_OLD_ORIGIN` set) on a free port, serves the old address's redirect page on
a routed made-up origin, and brings a save over in real windows, desktop only. Failure traces, screenshots
and videos land in `test-results/` (uploaded by CI). `agent-audit.spec.ts` checks only the audit's
browser boundary; the agent audit itself runs locally only (see
[Local agent usability audit](#local-agent-usability-audit)). `npm run check` doesn't run these specs; CI
does. Run one locally with `npx playwright test tests/browser/<spec>` (`npx playwright install chromium`
once if the browser is missing) only when fixing a browser-test failure or when a UI, CSS or gesture change
can't be checked otherwise, and grep `tests/browser` for any constant you changed. Owner decision, 2026-10-16/17 (#8 and #211, both closed: "own phone fine, weaker = emulation"):
Pixel 5 emulation counts as phone evidence when the PR labels it as emulation; a physical-device check is
stronger, and is done by hand against the preview and described in the PR.

Browser tests have no retries, so a test that fails once fails CI: fix its cause rather than re-running.
Wait on a state the page exposes (an attribute, a role, text) rather than on time; for example the card
close-up sets `data-tilt="live"` once it follows the mouse.

### Cross-browser smoke (Firefox and WebKit)

`npm run test:browser:compat` runs the journeys tagged `@cross-browser` on desktop Firefox and WebKit with
iPhone 13 touch emulation (`playwright.compat.config.ts`); the rest of `tests/browser` stays on Chromium. The tags
sit on three existing tests, so these run in the Chromium suite and its burn-in too:

- `pack-opener.smoke.spec.ts`: one real pack (Worker and WASM ticket, cards and images, summary) and its exact
  stats, collection and history after a reload (localStorage and IndexedDB).
- `card-share.spec.ts`: a card's share sheet from My pulls, with the clipboard stubbed.
- `share-fallbacks.spec.ts`: a pack's share sheet, its stubbed copies, and the copied link opened in a fresh tab.

Add `{ tag: '@cross-browser' }` to a test to include it, and keep the set small: it is a smoke, not a second
suite. Every test uses the same network guard as the Chromium suite (no outside HTTP or WebSockets, a disposable
identity, nothing published, exported or shared natively). The reporter prints each project's engine, version and
passed, failed, skipped and flaky counts, and adds them to the CI job summary. Install the browsers once with
`npx playwright install --with-deps firefox webkit`. CI runs this job, the `browser-tests` shards, the `browser-burn-in` shards and `visual-baselines` in Playwright's official image
(`mcr.microsoft.com/playwright`, tag equal to the `@playwright/test` version and pinned by digest), which already holds the
browsers and their libraries, so none of them installs anything; when you bump Playwright, bump the tag and digest in all of
them (`scripts/hof-workflows.test.ts` fails until they match). The Chromium there is the image's, not your machine's, so a
layout that differs only in CI is worth a look at the font and the browser build before the test.

The job isn't part of `browser-tests` and isn't required; making it required is a separate decision once its
runs are stable. A failure that shows a real app bug in one engine is reported as one, not worked around in
the test. This is Playwright's Linux WebKit with touch emulation: it is not iOS Safari, a physical phone or
the native share sheet, and says nothing about them.

### Automated axe checks

`tests/browser/axe-scan.ts` is the one place that runs axe (`@axe-core/playwright`, a devDependency) in a
browser spec. `axe-critical-states.spec.ts` calls it for four loaded states: the first pack, the pack
summary, Settings and a card's share sheet over its viewer, in both projects. `axe-routes.spec.ts` adds
mid-reveal, Cards, Rankings, Profile and a shared pull, and checks that each page, Settings included, is a
named main landmark with one level-1 heading and has no focusable control stranded off the page (a control
in a horizontal scroller is not stranded). Those checks wait for the page's own content first, so the loading
placeholder is never judged; Cards runs on a saved whole-set collection. A coverage test fails when a page in
`PAGE_TITLES` has no scan, or a state in `AXE_STATE_SPECS` is not scanned by the spec that owns it. A scan runs a fixed list of
rules (names, roles and relationships, the document, and `color-contrast`) after fonts, images and finite
running animations have settled, with reduced motion emulated for the scan so looping pulses cannot make
contrast depend on their phase; it is not a tag or the whole rule set, and no rule is disabled. Add a state by
awaiting `expectAxeClean(page, testInfo, '<state>')` directly in a test body once its screen is loaded, after
naming the state and its owner spec in `AXE_STATE_SPECS`; do not add another scanner.

- A scan fails on any violation, on a scan that passed no nodes, and on a page where contrast or the
  document checks found nothing to check, so an empty or wrong page cannot pass.
- Axe cannot judge text on art, gradients, overlapping layers, partly transparent backgrounds or
  pseudo-element backgrounds, canvas contents or images. It lists those as "needs review"; each scan attaches
  them to the test report, adds an `axe-needs-review` annotation and prints one line per scan, so the list
  shows in CI logs. Treat them as unchecked, not as passing.
- An accepted violation goes in `AXE_EXCEPTIONS` with its state, exact rule and selector, the reason, an
  owner and what removes it (a test rejects an entry with a blank field or an unknown rule or state). An entry
  that stops matching fails the scan, so the list only shrinks. It is empty today; use it only with a linked follow-up.
- A green scan is not a full accessibility audit or a physical-phone check. Keyboard order, focus rings,
  reduced motion, target sizes and screen-reader wording stay with the specs that own them.

The `browser-burn-in` jobs run on every push and every pull request. They re-run each spec the branch
adds or changes, plus every spec that imports a helper under `tests/browser` the branch changes, in both
projects:
- 10 more times when few specs changed;
- fewer as the list grows (see `scripts/burn-in-plan.ts`), but never fewer than 2, and no spec is dropped.

Changes to `playwright.config.ts` or app code burn in nothing; the regular shards still run every spec
once. Before pushing a new or changed spec, run the same locally with
`npx playwright test <spec> --repeat-each=10`.

### Visual baselines

`tests/visual/screens.spec.ts` compares four screens with reviewed images in `tests/visual/baselines/`:
a new player's first pack, its summary, the share sheet for that pull and that set's part of the Cards page, each
at a phone width (Pixel 5 emulation) and at 1280×800, at scale 1 (#745). It reuses the browser smoke's
build, fixture player and helpers, and the browser specs still own behaviour (focus, hit-testing,
keyboard, reflow); an image only says the screen looks as someone last approved it.

Pixels depend on the browser build and the font rasteriser, so the images are drawn and compared only
in the pinned Playwright image, the one the `visual-baselines` job in `browser-tests.yml` uses (its
tag matches the locked `@playwright/test`; `scripts/visual-baselines.test.ts` keeps this command, the
job and the lockfile in step). Run it from the checkout with Docker; the second `-v` gives the
container its own `node_modules`, so a macOS or Windows install isn't used:

```sh
IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
docker run --rm --ipc=host -v "$PWD":/work -v /work/node_modules -w /work "$IMAGE" sh -c 'npm ci && npm run test:visual'
```

Files it writes come out owned by root on a Linux host. The job runs as the runner's uid on Node 22
instead of the image's Node; the browser and fonts, which draw the pixels, are the image's either
way. Running `npm run test:visual` outside the
image draws different pixels and fails; that is not a design change.

- **Fixed inputs.** The fixture player and its first ticket, the set it opens (Summer of Slop, not
  the newest, so a release leaves the images alone; docs/ADDING_A_SET.md), the browser, viewport and
  scale, the preview's port and base path (the share sheet's QR code encodes the address, so
  `PREVIEW_PORT`, `BASE_PATH` and `SITE_URL` are ignored here), locale and time zone, `Date` (timers
  stay real, see the spec), reduced motion, and CSS animations and the caret at capture. Every wait is for a state (a role, decoded art, loaded fonts, the toasts gone), and
  Playwright takes shots until two agree before comparing.
- **No tolerance.** `threshold: 0` and `maxDiffPixels: 0`: the image draws the same pixels on every
  run (checked with `--repeat-each=10` in the image), so any difference is a change to look at. Don't add a
  tolerance or a mask to get green; if a screen stops being stable, fix what moves.
- **On a mismatch** the job fails and uploads `visual-baselines-diff` (7 days): the expected, actual
  and diff PNG of each screen that changed, at most 24 images of a few hundred KB. There are no
  traces or videos, which would hold the fixture's saved data. A run takes about a minute after the
  build; the job is capped at 20 minutes and the committed images at 3 MB.
- **Updating.** When a change means to alter a screen, run the command above with
  `npm run test:visual -- --update-snapshots=changed`, which rewrites only the images that differ,
  and commit them with the change. CI never writes or accepts a baseline (it runs with
  `--update-snapshots=none`), and a new screen fails there until its image is committed.
- **Review.** A baseline change is a design change. Someone other than its author (the PR's reviewer,
  or the owner for tone and art) opens each changed image on the PR's head commit, compares it with
  the old one and docs/DESIGN.md, and approves that head. A later push that touches an image needs a
  new look. Don't approve an image that shows a known defect, such as overlapping controls.

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

## Quality review cadence

The trusted `/work` lifecycle (`.claude/skills/work/SKILL.md`) runs `npx tsx scripts/quality-review.ts
check` at setup and at checkpoints (#713), only between tasks (never to wake an implementer or start a
workflow). Not due, it prints the one due line plus any flow-change line and nothing else. It reads the one `quality review:` ledger line and decides
due or not due: due when the next-due day (default 7 days after a finished review, 1 day after a
blocked or unrun one) has come and `main` changed since the last passed review. It never runs the
suite or an audit, makes no network calls and wakes no one. When due it names one slice and its
budget (default 3 tasks, 45 minutes, 2 provider runs):

- one player journey, rotating through opening, collection and detail, sharing, own and shared
  Profile, Rankings, Settings and help, and recovery, with a journey whose code changed since the
  last review first. Opening, sharing and recovery use the task audit above (Claude only, a fresh
  task-only reviewer, no coaching); the rest use fixture-based browser checks. Judge it with the
  player job, primary fact, next action check (#712). Separate same-scope duplication from necessary
  repeated context, accessible text and exported artifacts. A screenshot baseline (#745) never
  stands in for that review.
- one recently changed code hotspot (commits times lines from `git log`), rotating away from the last pick;
- the escaped-defect replay below (about 2 minutes, no task or provider run). Its `defect-replay`
  signal, written by that run, is the item's result;
- the status and age of existing signals: CI and review failures, test runtime and performance
  (#702, report-only), capacity (#708/#709/#242), compatibility (#658), release blockers
  (the #759 record only: pass needs the current record version and every entry valid and `resolved`
  by the `release-blockers.ts` rules, its fix commit and regression test on `origin/main`; anything
  else is open or invalid. Dated by its last commit on `origin/main`, or undated in a shallow clone
  when that commit is the shallow boundary), dependency advisories, branch hygiene (#710) and the last task audit. Each is
  pass, fail, blocked or unrun. A missing report is unrun, and a physical device, a screen reader
  and native sharing stay unrun until a person records a result. Only a date the report states
  counts: a file mtime is shown as `date: unknown (mtime only: ...)` and never reads as fresh.
  Performance shows its measured commit and is a pass only for a clean run (`trackedSourceDirty:
  false`) of a commit that is an ancestor of `origin/main`.

When due, spend at most the budget on that slice with the existing tools, search issues and PRs
first, comment evidence on the canonical issue, and open one bounded task only for a reproduced,
non-duplicate gap. Then run `record --status=<pass|fail|blocked|unrun> --journey=<id> --hotspot=<file>
--issues=#n` (journey is an id above, hotspot a repo path of at most 60 characters) and replace the
ledger's one `quality review:` line with its output. A hotspot with no changed code is `n/a`, not
blocked, and is left out of the status. History is read from `origin/main` only.

Reports come from their own tools (`test-results/...`) or a compact `{status, date, detail}` JSON in
`test-results/quality-evidence/<id>.json` (gitignored, one file per source, overwritten, no logs,
saves or secrets). The coordinator writes `ci-review`, `test-runtime` and `dependency-advisories`
itself during a due review, from what it already read (PR checks, last CI timings, advisory lists),
before `record`; `scripts/branch-inventory.ts --confirm=<batch> --evidence` writes `branch-hygiene` (Branch hygiene,
below); `scripts/defect-replay.ts` writes `defect-replay`
(below; a pass counts only for a replayed commit on `origin/main`, as for performance); a person writes `physical-device`, `screen-reader`,
`native-share` and `compatibility` when they have a result. The cadence never opens a recurring
"audit" issue. `record` prints the new ledger line (default cadence, budget and next-due day are omitted and revisions are always 7 characters, to keep it short; it refuses a line over 215 characters and names the optional fields to reset). Only a pass moves the passed date. A fail is a finished review: it
rotates to the next journey and hotspot and is next due after a full cadence. A blocked or unrun review keeps its slice
and is retried the next day. The cadence adds to per-PR checks (flow changes still get their reviews at once) and
does not replace them. `scripts/quality-review.test.ts` holds the dry runs: not due, due success,
missing tools or exhausted budget, and the evidence, size and argument checks.

### Escaped-defect replay

`npx tsx scripts/defect-replay.ts` (about 40 seconds, never part of `npm run check`) checks that the
unit gate still stops three defects that once reached main (#758). For each one it checks out HEAD
into a disposable worktree under the system temp directory, runs the owning test file through the
same Vitest config, then reverts the fix there and runs it again. The runs get no GitHub token and
a dead proxy. Nothing in the shared checkout changes except `test-results/quality-evidence/defect-replay.json`.
That file is `{status, date, detail, revision}`. It reads `blocked` from the moment a run starts,
so a crashed run never leaves an older pass standing. A run that is interrupted leaves its worktree
behind; each scratch directory names its process, and the next run removes those whose process is gone.

| Case | Invariant | Fix | Owning test | Reversion | Observed failure |
| --- | --- | --- | --- | --- | --- |
| #694 | a failure on this device is operational, never a fabricated pull | 729a8af (#926) | `PullViewerPage.test.tsx`, operational Worker/WASM failures | the catch-all branch sets `invalid` | shows "Not a valid pull" where "Couldn't check this pull" belongs |
| #647 | a null, array or primitive save file is refused before any field is read | 1209cf0 (#912) | `SettingsPage.test.tsx`, rejects null, array and primitive JSON | the non-object guard removed | the file is reported as "Couldn't read browser storage" |
| #660 | malformed legacy stats migrate without throwing or fabricating a best pack | c99a523 (#905) | `migrations.test.ts`, null legacy v1 `highestPackCards` | every element hydrated as a card | `runMigrations` throws `TypeError: Cannot read properties of null` |

A case is `validated` only when the named test passes healthy and fails with the reversion, with a
message matching the reason the case states. It is `ineffective` when the reverted code still
passes, which happens when the test is vacuous or a mock removes the defect. Everything else is
`inconclusive`: the test isn't discovered, is skipped or todo, the healthy run isn't clean, the
fixed code moved so the reversion no longer applies, or the faulty run fails to load or fails for
another reason. Four meta-cases run the same way and must reach their stated verdict: a test name
that matches nothing, the #660 reversion against `src/main.test.tsx` (which mocks the migrations,
so it is `ineffective` there), a reversion that breaks parsing, and a reason no failure produces.
The run passes only when all three cases are validated and all four meta-cases are right. A missed
defect or a wrong meta-case is a `fail`, an inconclusive case is `blocked`, and the exit code is
non-zero for both. The quality review shows the file as its `defect-replay` signal.

CI runs it on every pull request that changes the gate itself: `vite.config.ts`, `src/test/`, `package.json`, `package-lock.json`, `scripts/test-budget.ts`, this
script and its test, or a file a case owns or reverts (`GATE_PATHS` in the script). The step is in
the `unit-tests` stage, which the required `check` gate needs, and diffs the merge commit against
its base, so a `fail` or `blocked` replay turns that check red and blocks the merge until it is
fixed or the case is updated to the moved code. Other pull requests skip it with one line. Each
quality review runs it as a slice item (above). `scripts/defect-replay.test.ts` fails in the normal
checks when a reversion no longer applies, and pins the CI step. The case stays a gate: it is never
made report-only because it catches its defect.

Findings and limits:
- #741, the browser monitor missing a redirect between two local origins, isn't replayed because
  its reversion needs a Playwright run, outside this unit-suite harness. It is probed:
  `tests/browser/network-guard.spec.ts` ("redirect escape to external provider is refused with 403")
  redirects to a second `127.0.0.1` server. A bounded Playwright replay slice could cover it later.
- #660 has more than one gate. Besides `migrations.test.ts`, the #660 tests in
  `src/test/legacySave.integration.test.ts` (the real App and migrations) fail with the reversion.
  Only `src/main.test.tsx` mocks the migrations; the meta-case shows that one test alone would miss it.
- Three cases show these tests stop these reversions. They are not a catch rate for the suite.
  Agreement between model reviewers is not independent assurance either.

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

| Budget | Baseline (October 2026, Node 22.23.3) | Enforced | Set in |
| --- | --- | --- | --- |
| Wall time of the whole run | 120.9 to 196.3 s (median 167.7 s) on the four latest successful main runs on CI, at 2,388 to 2,667 tests; 111.2 s at 1,819 tests (`2bf6074`); median 150.8 s (150.7-155.5 s) on a 2-core container at 1,819 tests, 150.0 s at 2,667 | at most 400 s | `RUNTIME_BUDGET_SECONDS` in `scripts/test-budget.ts` |
| Coverage of `src/` app code, excluding tests, `src/test/` helpers and `.d.ts` | branches 91.2-91.4%, statements 94.7-94.8%, lines 96.5-96.7% on those main runs | at least branches 75%, statements 78%, lines 80% | `test.coverage.thresholds` in `vite.config.ts` |

After the test summary, and before the coverage summary, the run prints
`Test budget: N tests in M files took Xs (budget 400s)`, and it fails only past the budget. The
runtime budget holds for every `npm test` run, whatever flags follow `--`: the `testBudget()` plugin
in `vite.config.ts` adds its reporter after `--reporter` flags replace the configured ones, so
`npm test -- --reporter=dot` keeps it, and `npm test -- --coverage.enabled=false` drops only the
floors. Targeted `npx vitest run <path>` runs skip both budgets; adding `--coverage` to one turns
the floors on, and a partial run won't meet them. Coverage rides in the one test
run: it stayed within 0.05 points between runs, and earlier measurements put its cost at up to 20%
wall time. Instrumentation makes the CPU-bound engine simulations about 3x slower, and under heavy
load two of them once passed the 5 s default timeout, so `npm test` passes `--testTimeout=15000`.

### Reference runner and runner conditions
- **Reference runner**: the GitHub-hosted 4-vCPU Linux runner (Node 22.23.3, Vitest 5.0.4 at first,
  5.0.5 on the runs below; the job log doesn't print the core count). The main
  deployment run 39059778425 (build job 117475232914, revision `2bf6074`) ran 1,819 tests in 147
  files in 111.2 s with coverage, at 90.60% statements, 88.76% branches and 92.05% lines.
- **Main CI baseline (October 22-23, 2026)**: `ci.yml` doesn't run on main; main's `npm run check`
  runs in the `build` job of `deploy.yml`, so its `Test budget:` line is the main figure. Method: list
  the latest successful `deploy.yml` runs on main, download each `build` job log and read the
  `Test budget:` line, the `RUN v...` header and the coverage summary. Four consecutive runs, all on
  `ubuntu-26.04` image 20261012.163.1, Node 22.23.3, Vitest 5.0.5, `npm test` with coverage and no
  other workload in the job:

  | Run | Head | Tests / files | Test budget time | Branches / statements / lines | `npm run check` step |
  | --- | --- | --- | --- | --- | --- |
  | 39866957487 | `d3b212b` | 2,388 / 171 | 156.3 s | 91.20% / 94.65% / 96.46% | 190 s |
  | 39870858789 | `88c585b` | 2,452 / 174 | 179.1 s | 91.36% / 94.80% / 96.63% | 216 s |
  | 39873456480 | `eb35e02` | 2,560 / 179 | 120.9 s | 91.42% / 94.84% / 96.67% | 145 s |
  | 39876011560 | `819311f` | 2,667 / 181 | 196.3 s | 91.38% / 94.82% / 96.67% | 235 s |

  Median 167.7 s, range 120.9-196.3 s. The spread is not suite growth: the fastest run came after
  two slower ones with 4-7% fewer tests, and seconds per test ranged from 47 ms to 74 ms. The same
  commit (`819311f`) took 196.3 s in the push run above and 190.6 s in main run 39880083163 (a
  `workflow_dispatch` run, build job 120175204245: 2,667 tests in 181 files, `npm run check` step
  about 226 s), so the slow end is a stable runner class and not a one-off tail. It is not a slow
  or hanging file either: the per-file profile is the same in every run. `check-sets.test.ts` is
  8.4-9.4% of the summed file time in the three runs that include it (it was added at `eb35e02`),
  the top 10 files are about 51%, and they are mostly the same files. Every file scales by roughly
  1.5-2x between the fast and the slow runs, so no file is an outlier. The whole `npm run check`
  step took 145-235 s, about 24-39 s over the test time for lint, types, set locks and card assets.
- **Earlier growth**: CI runs at 1,926 tests in 151 files took 141.2 s and 112.7 s on the same head
  (PR #941), and the claude/train-1 integration branch took 157.9 s at 1,990 tests in 155 files
  (job 119941611004), over the old 150 s budget with every test passing. The slowest files there
  ran 8-30 s each, spread across many integration and script tests, with no single outlier.
- **2-core container**: three serial `npm test` runs at `2bf6074` (Node 22.23.3, Vitest 5.0.4, 2 CPU
  cores by cgroup quota, 8 GiB memory, nothing else running) took 155.5 s, 150.7 s and 150.8 s
  (median 150.8 s, mean 152.3 s). All 1,819 assertions and the coverage floors passed, but every run
  exited 1 on the 150 s budget. That gap (150.8 s against 111.2 s at the same revision, `2bf6074`)
  has not been isolated. It did not reproduce in two later local runs at `819311f` (2,667 tests),
  which took 150.0 s and 150.6 s, inside the CI range of 120.9-196.3 s; their core count and
  versions were not recorded. For another local data point, `npm run check` on a 4-core, 15 GiB
  container (Node 22.22.0, Vitest 5.0.5) took 137.8 s at `e9de5f2` (2,680 tests).
- **Developer workstations**: no figure has been measured here. To get one, run `npm test` three
  times on an idle machine and record Node version, core count, memory and the `Test budget:` line.
- **On 2 cores or a loaded machine**: the budget line can fail while every assertion and floor
  passes, so read that line before treating a failure as a regression, and rely on CI for the
  authoritative wall time. `--coverage.enabled=false` does not help: it drops only the floors, and
  the budget reporter still runs. Don't use `--isolate=false`: it is untested here, and the
  integration tests rely on per-file isolation (`dispose()`, `vi.resetModules`). During iteration run
  `npx vitest run <path>`, which skips both budgets.

The coverage floors sit about 13-16 points below the baseline (91.2% branches, 94.7% statements,
96.5% lines against 75%, 78%, 80%). The runtime budget is 400 s, about 2.0x the slowest main CI run
(196.3 s) and 2.4x the median (167.7 s), which is the twice-the-slowest rule below. It was 300 s,
but the hosted runner took 1.6x as long in one main run as in the one before it (196.3 s against
120.9 s, on different commits 4% apart in test count; the one same-commit pair, 196.3 s and 190.6 s,
differs by 1.03x). The suite has also grown 47% (1,819 to 2,667 tests) since audit revision
`2bf6074`, and 34% since the 300 s budget was set at 1,990 tests (#947). So 300 s was about 1.5x the
slowest run and would trip at about 4,000 tests (74 ms per test at the slowest rate) on an ordinary
run. At 400 s the budget trips at about 5,400 tests at that rate. A hung test is caught by the 15 s
per-test timeout, not by this budget. If a main run passes about 300 s, profile the slowest files
first. Local runs on a loaded 4-core or 2-core container are slower than CI, so a local overrun
alone isn't a regression. Ordinary
work shouldn't trip the floors. To move one, run `npm test` three
times on an up-to-date branch, set each floor a few points below the lowest figure and the runtime
budget to about twice the slowest run, and give the old and new numbers in the PR. Lower a floor
only for removed or unreachable code, never to land untested code. When the runtime budget trips,
look for a slow or hanging test before raising it.

## Shuffled and repeat runs

`.github/workflows/test-order.yml` runs the unit suite on a schedule (06:41 UTC) or by hand from the
Actions tab, never for a pull request. It runs `vitest run` with files and tests shuffled by one
seed, then again with the same seed in the same job. A test that fails only shuffled depends on what
another test left behind; one that fails in only one of the two runs depends on the clock,
`Math.random` or load. Both runs leave out coverage and the runtime budget, which per-PR CI owns,
and nothing is retried. The runs sample orders: a green night doesn't prove the suite
order-independent, and GitHub's schedule is best effort (it has never fired the Hall of Fame inbox
here), so a night without a run is not a pass.

The seed is the run id modulo 10^9, or the `seed` input of a manual run. The job log
(`Shuffle seed: ...`) and the run summary record it with the revision. To replay a failure exactly:

```sh
git checkout <revision> && npm ci
npx vitest run --testTimeout=15000 --sequence.shuffle --sequence.seed=<seed>
```

Adding the failing file's path to that command keeps the order of the tests within the file but
not the order of files, so if the file alone passes, replay the whole suite.
A failure, timeout or cancel comments on the open `test-order` issue that the workflow opened, or opens one, with the
seed, revision, run link and replay command. File each root cause as its own issue and link it
there. Fix the test, never loosen or skip it, and close the issue once a run passes again.
`scripts/hof-workflows.test.ts` checks the workflow's permissions and runs its seed and report steps,
in the shell each declares, against a fake `gh`.

## Operational health

`.github/workflows/ops-health.yml` reports on main's deploys and the Hall of Fame inbox from signals
that already exist (#715). It runs every 6 hours (best effort, like every GitHub schedule here),
whenever a deploy of main finishes, and by hand from the Actions tab. `scripts/ops-health.ts` reads
the runs; the run summary shows the table and `ops-health.json` (artifact, 14 days) holds the same
report.

Signals it reads, all through the run's own `GITHUB_TOKEN` (`actions: read`):

- the newest 20 runs on main of `deploy.yml`, `hall-of-fame-inbox.yml`, and, report only,
  `hall-of-fame.yml`, `test-order.yml` and `performance-baseline.yml`. A relay probe dispatch of
  the inbox skips its inbox job, so it is titled `Hall of Fame relay probe` and left out;
- main's newest commit and its time;
- `hof-inbox-summary.json`, which each inbox run uploads (artifact, 3 days) even when it fails:
  revision, run id, time, the stage it reached, outcome, relay count and failures, events read,
  pulls checked, issues added, events deferred, why it stopped (`budget`, `filing-cap` or
  `write-failed`) and the oldest deferred event's age. Counts and fixed words only. The newest 6
  successful runs' summaries are read, and only one whose run id and revision match its run counts.

Not available, so not claimed: Cloudflare (the inbox cron Worker and any analytics) and GitHub
Pages traffic or uptime. Neither has a log or dashboard this repository can read, and adding one
needs the owner's accounts. A Worker that stops dispatching shows up only as `inbox-stale`.
Pending: production smoke against the deployed site (#707, open, not built). Until it lands, a
successful deploy says the release passed its own checks, not that players can load it.
`ci.yml` and `browser-tests.yml` skip main, so main's health is its deploys.

| Condition | Unhealthy when | Runbook |
| --- | --- | --- |
| `deploy-failing` | the newest finished deploy failed, was cancelled or skipped | open the run, fix main, let the next merge or a manual deploy run |
| `deploy-behind` | main's newest commit is over 3 hours old with no successful deploy | look for a queued, cancelled or failed deploy of that commit; dispatch `deploy.yml` once fixed |
| `inbox-failing` | the newest 2 finished inbox runs each failed, were cancelled or skipped (one alone is unknown: a run with every relay down is a blip) | its summary's `stage` says where it stopped; the run log has the error |
| `inbox-stale` | no successful inbox run in 2 hours, or none among the newest 20 | check the Worker dispatch (the owner's Cloudflare account) and the workflow's enabled state |
| `inbox-deferring` | the newest 3 successful runs all left events for later | the summaries' `stop` names the cap; a backlog that keeps growing needs a bigger budget or filing cap |

Each condition is ok, unhealthy or unknown. Unknown means it couldn't tell: the runs couldn't be
listed, a newer run is still going, a commit is inside its deploy grace, or a summary expired or
never uploaded. A run that was skipped, cancelled or never happened is not a success, and an
unobserved summary is not an empty queue: the inbox reads at most 50 pages of 100 events over a
7-day relay window, checks at most 300 pulls and files at most 20 per run, so a zero from a run
that stopped early is not a zero backlog.

The report job keeps one issue per condition, labelled `ops-health` and found by its exact title.
It counts only issues that `github-actions` or evanlin23 opened, because the repository takes public
issues. When a condition turns unhealthy it opens the issue, or reopens the newest closed one with a
comment; when the condition is ok it closes the open one with a comment. It does nothing while the
state is unchanged or unknown, so it never comments on every run. If the issue lookup fails the job
fails and writes nothing. A failed `ops-health` run is itself the signal that the report is broken.
The Claude `/work` queue owns these issues; anything that needs the owner's accounts (Cloudflare,
repository settings) goes to evanlin23 under `needs owner`. The quality review cadence reads them
with the other existing signals.

Cost: a public repository's Actions minutes are free; each run makes at most a few dozen API calls and
downloads at most six small artifacts. It needs no secret beyond `GITHUB_TOKEN`, and the report job
never checks out code. It never exports player keys, proofs, saves, event ids, relay addresses, URLs
from the inbox, error text or other free text. `scripts/ops-health.test.ts` covers healthy, failed,
stale, missing and partly observed states and the sanitizing, and `scripts/hof-workflows.test.ts`
runs the report step against a fake `gh`.

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
own metric limits. **It is emulation, so label it as such** (owner decision 2026-10-16/17, #8): page-level CDP throttling doesn't throttle
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
`test-results/performance-optional-work/`. It's **desktop-Chromium emulation**, so label it as
such (#8, closed 2026-10-16/17): CDP's CPU slowdown doesn't throttle workers, and the pool size follows the emulated
navigator. `npx vitest run tests/performance/optional-work.test.ts` checks its report.

### Pending Hall of Fame checks (opt-in)

`npm run test:performance:pending-verify` (report-only, in no check or CI job) times the Rankings
page re-deriving pending pulls (#777). `scripts/pending-verify-fixture.ts` writes 10 signed pulls
that each qualify; stand-in relays serve them and 3 published rows replace `hall-of-fame.json`.
Each run records, from the Rankings click: published-board paint, the first and last pending row,
each pending ticket's mining time and the worker's idle time between them, workers created, peak
busy tickets (× `TICKET_PARAMS.memorySize` for the Argon2 estimate), long tasks and frame gaps while
they're checked, and the main-target heap. It prints one JSON line per run. Same profile and
emulation limits as above (#8): the CPU slowdown reaches the page's main thread, not the worker.

**Outcome (#777): pending pulls stay checked one at a time.** Tickets already mine one at a time in
one worker (`ticketMiner.ts`, 32 MiB each), so running checks in parallel would need a second
worker and twice the Argon2 memory. A one-ahead variant kept one worker and just queued the next
ticket while the last result was applied. Measured interleaved, n=15 each, on a 4-vCPU 2.1 GHz
Xeon host with Chromium 141 headless at `819311f` (emulation, not a device), as median
(25th to 75th percentile):

| | One at a time (kept) | One ahead |
| --- | --- | --- |
| Published board | 302 (270 to 309) ms | 293 (242 to 309) ms |
| First pending row | 889 (826 to 909) ms | 927 (910 to 972) ms |
| Last of 10 pending rows | 4103 (3939 to 4178) ms | 3970 (3893 to 4105) ms |
| Worker idle between tickets, total | 249 ms | 13 ms |
| Long tasks while checking: count, total | 5, 734 ms | 9, 1001 ms |
| Peak busy tickets, workers created | 1, 3 | 1, 3 |

The One ahead column is a record of a trial variant: that code isn't in the tree, so the harness
reproduces only the kept column.

Going one ahead saves about 3% on the last row (the ranges overlap) and costs about 4% on the
first row. It also adds main-thread long tasks, because the next pull's checks run while the
worker mines. On a phone the worker slows down as much as the main thread does, which shrinks that
saving further: unthrottled, tickets took about 220 ms with 60 ms idle in all. Leaving the page
aborts the check, so a pack opening never waits behind more than the one ticket already mining.

### Card art placeholders (opt-in)

`npm run test:performance:art-pending` (`tests/performance/art-pending.spec.ts`, report-only, in no
check or CI job) times how long card art stays a placeholder (#762) on a cold load at 360x640 with
touch, 120 ms per response, 1.6 Mbps down and the main thread slowed 4x. It opens two shared pulls
from `spec/vectors-python.json` (one with finishes, one plain) and a 20-row Rankings board, and
records when the pull shows as verified, when each slot is drawn (loaded, `data-state="ready"`),
when the first Rankings row and every row on screen have their thumbnails, and the card art's
requests and bytes. It prints one JSON line per run (`PERF_REPETITIONS`, default 3). Set
`CHROMIUM_PATH` when Playwright's own browser build isn't installed. Same emulation limits as above
(#8): the CPU slowdown doesn't reach the worker that re-derives a shared pull.

Before and after #762's changes, n=3 each, ranges, on a 4-vCPU 2.1 GHz Xeon host with Chromium 141
headless (emulation, not a device). The changes: the faces a screen shows first are fetched at high
priority, Rankings rows below the first screen load lazily, and the next pack's art isn't fetched if a
page, a shared pull, a profile or a share sheet covers the Open screen when its ticket is asked for.
The After column was measured with the timing spec as it stands, on `86ede13`'s code (later commits
change only comments, docs and unit tests).

| | Before (`8674c13`) | After (`86ede13`) |
| --- | --- | --- |
| Finished pull: verified | 3950 to 3983 ms | 3946 to 5257 ms |
| Finished pull: last slot drawn after verified | 4849 to 4883 ms | 2400 ms (all three) |
| Finished pull: art requests, bytes | 6 to 7, 494 to 657 KB | 5, 442 KB |
| Plain pull: last slot drawn after verified | 3683 to 3884 ms | 1533 to 1650 ms |
| Plain pull: art requests, bytes | 3, 317 KB | 2, 264 KB |
| Rankings: first row's thumbs | 8542 to 8856 ms | 8601 to 8925 ms |
| Rankings: every on-screen thumb | 13142 to 13339 ms | 12900 to 12952 ms |

The 5257 ms verify was the first run of its set and didn't come back: six more finished-pull runs gave
3852 to 4296 ms on `66bdc34` and 3822 to 4514 ms on main (`c5708d2`), each set slowest on its first run.
The shared pull covers the Open screen, so no next-pack art competes with verifying it.

Most of the pull saving is bandwidth the next pack's art no longer takes. Rankings is bound by
bytes: each 30 px thumb downloads the full-size art (about 144 KB), and 12 of them (1.73 MB) are
in by the time the screen's thumbs show, with or without the lazy rows. A smaller plain-card
thumbnail is what would move it.

### Proposed budgets (not enforced)

**No fail-on-regression gate exists.** Both harnesses set `timingGate: false`, nothing in
`npm run check` or PR CI runs them, and the Actions job only uploads reports. These budgets are
proposals for a reviewer to hold a change against, taken from one n=7 sample (Chromium emulation,
393×727, 4× CPU, 10/2 Mbps and 40 ms, a 4-vCPU 2.1 GHz Xeon host; **emulation, not a real device**). Timing
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
timing rows stay review flags, since emulated timings are noisy (#8 is closed), so a noisy runner can't block
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

## Capacity (opt-in)

`npm run test:performance:capacity` (`tests/performance/capacity.spec.ts`, #709) is **report-only and in
no check, PR shard or default CI job**, like the other opt-in performance runs above. It drives the real app
with a growing synthetic save and a bounded repeated-opening session, in both browser projects
(`--project=desktop-chromium`, `--project=mobile-chromium` for one), and builds and serves the app as
the browser specs do. Saves are built by `syntheticSave` (`tests/performance/capacity.ts`) from a
fixed seed and go in through Settings > Import, so the app's own validation, backup and reload run. **That
history is synthetic shape data, never a verified history or proof evidence, and it runs in emulated
Chromium on the host with no throttling, not on a phone.** Every report says so.

Scenarios: `growing saves` (imports each size, opens real packs, checks every record, count and
counter), `long session` (reloads, pages, dialogs, hide/show), `reconstruction` (records without cached
cards are re-opened through the worker pool, each stored once), and `failure and interruption` (a
refused storage write, a reload while a ticket mines, a reload mid-reveal, an import the browser can't
finish and its rollback), each with exact assertions.

Sizes are set by environment, digits only, each with a hard cap: `CAPACITY_HISTORY` (comma list, default
`0,500,3000`, at most 20000 each), `CAPACITY_PACKS` (real packs per size, default 2, at most 10),
`CAPACITY_SESSION_HISTORY` (default 500), `CAPACITY_SESSION_PACKS` (default 6, at most 20) and
`CAPACITY_UNCACHED` (default 4, at most 12). `npx vitest run tests/performance/capacity-report.test.ts`
checks the report schema, the configuration, the pool-size rule and the failure names.

**What fails and what is reported.** Functional violations fail the run: a lost, doubled or misnumbered
pack, a pack left on the pending shelf, a console or request error (aborted card art included), more
workers busy than the pool allows or created than its recycling explains, storage that grows by more
than a record's fixed shape allows, an import that isn't rolled back exactly. **Timing is never
asserted**: page start to a pressable Open pack, press to decoded result, long tasks, the main-thread
heap, storage bytes, workers created, recycled (replaced after `TICKETS_PER_WORKER` tickets) and peak busy
are recorded in the report, and a hang is caught by each test's own timeout. The pool cap is the app's own
`poolSize` run against the emulated device's navigator; beyond the ticket miner's worker and a pool of that
size per page, only `ceil(tickets / TICKETS_PER_WORKER)` replacement spawns are allowed, and no worker may
answer more than `TICKETS_PER_WORKER` tickets. The Argon2 figure is peak busy × `TICKET_PARAMS.memorySize`,
an estimate, not a measurement. A report is written to `test-results/capacity/<project>-<scenario>.json` only
after every assertion passed, with the revision, browser, seed and sample counts, and `writeReport` refuses
one that fails validation.

`CAPACITY_INJECT_FAILURE=<name>` corrupts one stored thing behind the app's back after the last pack, so the
matching check must fail the run and no report is written: `history` (drops the newest record), `stats`
(packs opened back to 0), `collection` (one card count off by one), `nonce` (next number one too low) or
`shelf` (a pack left on the pending shelf). Any other value throws. Each was run once against the growing-save and
long-session scenarios; none is injected into the failure scenarios, whose own checks are exact comparisons
with the state before.

Measured on 2026-10-23 in the sandbox's Chromium over the built site, one run of each project, as
orientation only (nothing here is a ceiling): a 500-record save reaches a clickable pack in about 1.5-1.7 s;
the history key grows 149-173 characters a record; a real pack takes about 1.1-1.4 s from click to result;
re-opening 4 records without cached cards creates 4 workers (3 terminated, 3 busy at once) and stores each
once. The nine scenarios take about 1.3 minutes on desktop-chromium and on mobile-chromium each, at the default
sizes (`CAPACITY_HISTORY` 0, 500, 3000).

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

## Branch hygiene

Merged work leaves its branch behind, and the repository had 413 branches on 2026-10-23 (#710).
Retiring them is conservative and runs in the trusted `/work` lifecycle only.

**Who deletes.** Only the Claude coordinator, working under CLAUDE.md and the work ledger, deletes
branches. Implementers, reviewers, Codex, other agents and bots may run the inventory and
recommend; they never delete. Don't turn on GitHub's "automatically delete head branches" setting,
and don't add a scheduled or unattended deletion workflow.

This is a policy, not an enforced permission. Anyone with write access can delete an unprotected
branch, and the coordinator works through evanlin23's account, as other tools may. Naming a login
or a workflow "Claude" restricts nothing. The smallest enforceable step is for the owner:
- Add a repository ruleset that targets all branches with "Restrict deletions", with a bypass for
  the coordinator's identity only.
- Give other agents their own identities, with no bypass.

Until that exists, this section and CLAUDE.md are the restriction.

**When.** The weekly quality review's `branch-hygiene` signal (Quality review cadence above). A due
review spends part of its budget on one batch of at most 25 deletions. Holds and sleep apply as for
any other work, and there is no separate wake-up.

**Inventory (read-only).** Keep the clone, `pulls.json`, `keep.txt` and the outputs in a scratch
directory `<scratch>` outside the checkout, and run the script from the checkout:

```sh
git clone --bare --filter=blob:none https://github.com/evanlin23/BrainrotTCG.git <scratch>/inv.git
# Refresh: a bare clone has no fetch refspec, so a plain fetch would leave every branch tip stale.
git --git-dir=<scratch>/inv.git fetch --prune origin '+refs/heads/*:refs/heads/*' '+refs/pull/*/head:refs/pull/*/head'
# Every page of GET /repos/evanlin23/BrainrotTCG/pulls?state=all&per_page=100, saved as one JSON
# list of pages, plus the protected branch names from GET .../branches?protected=true.
npx tsx scripts/branch-inventory.ts --git-dir=<scratch>/inv.git --pulls=<scratch>/pulls.json \
  --keep=<scratch>/keep.txt --protected=main > <scratch>/inventory.md
```

`keep.txt` names branches to keep whatever their PR says: the branches of active sessions and of
the ledger's `current` and `order` lines, every branch a ledger hold mentions, and branches that
docs or open issues refer to. The script sorts each branch into one category; the first that
applies wins:

| Category | Kept or retired |
| --- | --- |
| protected | kept: the default branch or a protected one |
| open-pr | kept: the head or the base of an open or draft PR, stacked bases included |
| kept | kept: on the keep list |
| dependency | kept: Dependabot manages its own branches |
| recent | kept: tip committed in the last day, or a `claude/batch-*` branch in the last two days |
| candidate | retired: the tip is a merged PR's head, or an ancestor of it, and the clone's `refs/pull/<n>/head` is that head |
| unverified | kept: a merged PR's head holds the tip, but the clone has no `refs/pull/<n>/head` at it; refresh and re-run |
| merged-newer | kept: a merged PR, but the branch has commits after the merged head |
| closed-unmerged | kept: a closed PR that never merged may hold unique work |
| no-pr | kept: no PR from this repository, so its intent is unknown |

How these rules hold up:
- A squash or rebase merge leaves the tip outside `main`'s history, so ancestry with `main`
  proves nothing. The script compares the tip with the PR's merged head instead.
- A merged PR doesn't make later commits on its branch disposable.
- Age alone is not evidence of abandonment. The `recent` rule reads commit dates, so a just-pushed
  old commit can look old; the confirmation step below catches any tip that moves.
- Closed-unmerged, no-PR and merged-newer branches stay listed with their disposition. Ask the owner
  only when intent can't be recovered from the PR or issue.

**Delete (coordinator only).** Each candidate line reads `branch|tip|merged-PR#|merged-head`.
1. Re-read the ledger issue's holds. If they can't be loaded, delete nothing.
2. Put at most 25 candidate lines in `<scratch>/batch.txt`. Refresh the clone with the same command
   as above,
   `git --git-dir=<scratch>/inv.git fetch --prune origin '+refs/heads/*:refs/heads/*' '+refs/pull/*/head:refs/pull/*/head'`,
   and fetch the PR list again, then re-run the inventory command with
   `--confirm=<scratch>/batch.txt --evidence` added, writing to `<scratch>/confirmed.txt`. It prints only the lines whose branch, tip, PR
   and merged head are all unchanged, and writes the `branch-hygiene` evidence file under
   `test-results/quality-evidence/` in the working directory, so run it from the checkout. A
   skipped line is reclassified by the next inventory, not deleted. An empty, malformed or
   oversized batch exits 2 and writes nothing.
3. Delete the confirmed lines, each with a lease on its recorded tip, so a push since the
   check makes the delete fail rather than lose work:
   `git push --force-with-lease=refs/heads/<branch>:<tip> origin :refs/heads/<branch>`.
4. Record the deletion manifest (branch, former tip, PR, merged head) and the before and after
   totals on #710. Inventories are posted on #710, not committed to the repository.
Never issue a broad or age-based delete. Never delete tags, releases, set or proof files, deploy
artifacts, issues or anyone's local work. Other cleanup gets its own issue.

**Restore.** GitHub keeps `refs/pull/<n>/head` for every PR, so a retired candidate's tip stays
fetchable. Use the PR page's "Restore branch" button, or:

```sh
git fetch origin refs/pull/<n>/head
git push origin <tip>:refs/heads/<branch>
```

A bare SHA is not a backup. A commit that no ref reaches can be garbage-collected, and is gone if
the repository is deleted or replaced. That is why only branches whose tip a merged PR head reaches
are candidates. `scripts/branch-inventory.test.ts` shows the restore on a disposable local
repository and holds the dry runs:
- open, draft and stacked PRs;
- a held branch;
- a squash merge;
- a merged head with no `refs/pull/<n>/head` in the clone;
- a merged branch with newer commits;
- a closed-unmerged branch;
- a fork that reuses a name;
- a tip that changed before confirmation, end to end through a refresh with the command above;
- a confirm batch that is empty, malformed or over 25 lines.
