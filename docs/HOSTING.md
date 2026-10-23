# Hosting

The site is static files: no server, nothing to scale. It's built and deployed by
`.github/workflows/deploy.yml` to one of two free hosts.

| | Address | Cost | Limits |
|---|---|---|---|
| GitHub Pages (before the move; now redirects) | `evanlin23.github.io/BrainrotTCG` | Free, never billed | Soft limit of 100 GB of traffic a month; past it GitHub may slow the site or ask you to move |
| Cloudflare Pages (now) | `brainrottcg.pages.dev` | Free, no card needed, never billed | None for static files: traffic and requests are unmetered |

Either way, nothing on the free plans can charge you: there's no payment method to charge.

## Caching

- **Hashed, safe to keep forever:** everything in `assets/` (code, styles, fonts, card art, sounds).
  Vite names each file by a hash of its content (`name-XXXXXXXX.ext`), so a changed file is a new URL.
- **Revalidated, same name every deploy:** `index.html`, the files from `public/` beside it (icons,
  `og-image.jpg`, `hall-of-fame.json`), `robots.txt` and `sitemap.xml`, and the preview pages and
  pictures in `p/` and `s/`.
- **Crawler files:** the build writes `robots.txt` (allow all) and `sitemap.xml` (the app's address
  only; shares, profiles and sets are `#/` routes or `noindex` preview pages) for `SITE_URL`, or for
  production, `https://brainrottcg.pages.dev/`, when it isn't set, which is also what `index.html`'s
  checked-in link-preview tags name (`scripts/crawler-files.ts`). Staging serves the same files, but
  its page asks not to be indexed and the sitemap names only production.
- **Headers:** there is no `_headers` file. GitHub Pages sends a short `max-age` on every file, and
  Cloudflare Pages revalidates every file by default, so neither can serve a stale `index.html`
  pointing at code that's gone. If a `_headers` file is added, it may mark only `<base>assets/*`
  `immutable`.
- `npm run check:site` enforces this: unhashed `assets/` files, renamable files in other
  folders, code or styles loaded from outside `assets/`, and a `_headers` that breaks the rule all
  fail. CI runs it, and the browser test `tests/browser/built-site.spec.ts`, for both base paths.

## Moving to Cloudflare Pages

About five minutes, all in your browser:

1. Make a free Cloudflare account at <https://dash.cloudflare.com/sign-up>. Don't add a payment method.
2. Copy your **Account ID**: in the dashboard, open **Workers & Pages**; it's in the right-hand column.
3. Make an **API token**: profile icon → **My Profile** → **API Tokens** → **Create Token** →
   **Create Custom Token**. Give it one permission, **Account → Cloudflare Pages → Edit**, then
   **Continue to summary** → **Create Token**, and copy it (it's shown once).
4. In this repository on GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**. Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with those two values.
5. **Actions → Deploy to GitHub Pages → Run workflow** (or push anything to `main`).

The deploy then creates the Cloudflare Pages project `brainrottcg`, publishes the site at its root,
checks that the new address serves this exact build (its `deployment-id.json` names this run), and
only then turns the old address into a redirect. The run's log shows the new address (if `brainrottcg` is taken, Cloudflare adds a suffix).

What keeps working:

- **Old links and QR codes.** Every page at the old address forwards to the same place at the new
  one: pull links, profile links and link-preview pages (which keep their card preview).
- **Saves.** A save lives in the browser's storage for the address it was made on, and it holds the
  player's secret key. When a player with a save opens any old link, the old address offers
  **Bring my save and go**: one tap opens the new address in a small window and the two hand the
  save over directly (`scripts/redirect-site.ts`, `src/game/move.ts`). Each side checks the other's
  origin, which browsers enforce, so no other site can plant or take a save, and the save never goes
  in a URL (URLs end up in browser history and history sync). Players who arrive through a new link
  can do the same from **Settings → Save & backup → From the old address**. If a player already has
  a different save at the new address, they're asked first and the replaced save is kept as a backup;
  if the backup can't be stored, nothing is replaced. The old address keeps its copy and marks it
  moved (`brainrot-moved-v1`) once the new address reports that it stored the save or already had
  that player's save, or as soon as it sends the save to Save & backup; after that, old links go
  straight to the new address without offering the move. **Go without it** marks nothing, so the
  next old link offers it again.
- **The Hall of Fame.** The old address keeps serving `hall-of-fame.json` for the scripts, and the
  issue links it files redirect like any other link.

## Your own domain later

Domains cost money (about $10–15 a year), so this is optional, and it's best decided before the
move: saves only carry over from the GitHub Pages address, not from `pages.dev` to a domain added
later. To use one, add it in Cloudflare (**Workers & Pages → brainrottcg → Custom domains**), set a
repository **variable** (not a secret) `SITE_URL` to it, with or without the trailing `/` (for
example `https://brainrottcg.net/`), and deploy.

## Switching back to GitHub Pages

Delete the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets and deploy: GitHub Pages serves
the game again. Saves made at the Cloudflare address stay there, so do this before players settle in,
or not at all. This is a host change, not a release rollback; for a bad release, see
[Recover on the same origin](#recover-on-the-same-origin).

## Who can publish with the Cloudflare secrets

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are plain repository secrets. Pull requests from
forks never see them, but any workflow run in this repository can: a manual run from a branch runs
that branch's own `deploy.yml`, so the main-ref guard and the deploy contract only bind the file on
`main`. Anyone who can push a branch here could therefore publish to the Cloudflare project.

The jobs that hold the secrets (`site`, `stage` and `publish`) already run in the environment
`cloudflare-production`, which `scripts/deploy_contract.py` requires. GitHub creates it, with no
rules, on the first deploy that uses it. Limiting it to `main` is a settings change only the owner
can make, in this order:

1. **Settings → Environments → `cloudflare-production`**. Under **Deployment branches and tags**
   choose **Selected branches and tags** and add the rule `main`. Add no required reviewers: deploys,
   including Hall of Fame refreshes, would then wait for someone to approve each one.
2. In that environment, **Add environment secret** for `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` (same values, or a fresh token as in step 3 of the move).
3. Check that the next deploy on `main` reaches Cloudflare.
4. Only then delete the two repository secrets. Deleting them first makes the next deploy fall back
   to GitHub Pages as host ([switching back](#switching-back-to-github-pages)), or, with
   [staging](#staging) on, stop with an error and publish nothing.

## Staging

Every release can first go to a staging copy, tested where it runs, and production then gets
exactly the files staging served. It's off until the owner turns it on (below); while it's off,
deploys work as before.

With staging on, a deploy of `main` runs:

1. **build** builds once, with no secrets, and seals the files (`deploy_contract.py seal`: a SHA-256
   for every file, and one for the list).
2. **stage** checks the seal, publishes those files as a Cloudflare Pages *preview* (Wrangler's
   `--branch`, the branch named by `CLOUDFLARE_STAGING_BRANCH`) and waits until
   `https://<branch>.<project>.pages.dev/` serves this run's `deployment-id.json`. Then it fetches
   every sealed file from staging and fails if any one differs from its sealed hash.
3. **staging-checks** first checks staging still serves this run's `deployment-id.json` (a later
   run on the same commit may have replaced it, and a re-run would then test other files), then runs
   browser checks (`playwright.staging.config.ts`: the built-site check, the pack-opener and
   shared-pull smoke tests, and `tests/browser/staging.check.ts`) against the staging address, with
   no secrets. Nothing is rebuilt: the tests' copy of the site is the sealed one.
4. **publish** runs only if both passed. It checks the seal again and publishes the same files to
   production, then fetches every sealed file from production and fails if any differs. Both
   comparisons print the release's identity (commit, run, manifest hash, file count, Hall of Fame
   list hash) to the run summary, so the summaries of `stage` and `publish` show that the bytes
   tested are the bytes released.
5. **deploy** updates the GitHub Pages redirects as before, so old links and QR codes keep working.

What keeps staging apart:

- **Its own origin.** The staging address is a different origin from production and from the old
  GitHub Pages address, so its browser storage, saves included, never mixes with theirs. With
  staging on, the build is told the project's host (`VITE_STAGING_HOST_SUFFIX`); at run time, any
  subdomain of it is staging (`src/game/staging.ts`). With staging off it is told none, so no
  address, per-deploy `*.pages.dev` links included, is marked as staging. Staging shows a banner,
  asks not to be indexed, never offers to bring a save from the old address, and never publishes to
  the Hall of Fame. The same files at the production address are the normal game.
- **No real data.** Staging doesn't post to GitHub or anywhere public, and its browser checks run
  without secrets. The Hall of Fame list it serves is the one built in, read-only.
- **Fails closed.** With `CLOUDFLARE_STAGING_BRANCH` set, the site job stops the deploy, before
  anything is built or published, if the Cloudflare secrets are missing, the project isn't ready, its
  address isn't a `pages.dev` one, or the branch is `main`, the project's production branch, or not a
  valid branch name (lowercase letters, digits and dashes, up to 28). It never falls back to GitHub
  Pages as host while staging is on. Any failure in `stage` or `staging-checks` stops the run before
  `publish`, and production keeps serving the previous release.

### Turning it on, or off

1. Nothing new on Cloudflare: staging is a preview in the same project, with the same token. The token
   needs **Account → Cloudflare Pages → Edit** (step 3 of the move); its scope can't be checked from
   this repository. Don't put an **Access policy** on the project's preview deployments, and keep
   Cloudflare features that rewrite HTML off (for Web Analytics, use the JS snippet as in
   [Web analytics](#web-analytics), never automatic setup): the checks fetch staging without
   signing in and compare every file byte for byte.
2. After this change is merged and a deploy on `main` succeeds, add the repository **variable** (not a
   secret) `CLOUDFLARE_STAGING_BRANCH` with the value `staging` (**Settings → Secrets and variables →
   Actions → Variables**). The next deploy goes through staging, at
   `https://staging.brainrottcg.pages.dev/` (or the project's own address).
3. To turn it off, delete the variable. Staging's last copy stays up as a preview until it's
   deleted in the dashboard; it holds no secrets and writes nothing.

### Not checked from here

- The token's scope, and whether the project's previews are behind Access.
- Whether Cloudflare sends `X-Robots-Tag: noindex` for previews. The page asks not to be indexed
  either way, but from a script: staging and production serve the same `index.html`, so it can't
  carry a staging-only `noindex` tag, and a crawler that runs no scripts has only that header.
- Hall of Fame refreshes redeploy through the same jobs, so with staging on each one takes a few
  minutes longer (two full fetches of the site and the browser checks).
- The release-blocker gate (`scripts/release-blockers.ts`, #759) isn't wired into publish yet; that
  is a follow-up to #706.

Rollback is unchanged ([Recover on the same origin](#recover-on-the-same-origin)): roll back to an
earlier *production* deployment. A staging preview is never a rollback target.

## Web analytics

Production can count visits with Cloudflare Web Analytics. Our build adds Cloudflare's JS snippet,
so production serves exactly the bytes the deploy sealed; Cloudflare's *automatic setup* injects
its beacon on the way out instead, and then every release fails the byte-for-byte checks
("Check production serves this release"). To turn it on:

1. In the Cloudflare dashboard, open **Web Analytics**, then the site's **Manage site**, and switch
   to **Enable with JS Snippet installation**.
2. Copy the token from the snippet it shows (`data-cf-beacon='{"token": "..."}'`: 32 lowercase hex
   digits) into the repository **variable** (not a secret) `CLOUDFLARE_ANALYTICS_TOKEN`
   (**Settings → Secrets and variables → Actions → Variables**).
3. The next deploy carries it. To turn analytics off, delete the variable, then switch Web
   Analytics off for the site in the dashboard (or back to the snippet, never automatic setup).

What the build does with it (`scripts/cloudflare-analytics.ts`):

- Only the deploy's production build on Cloudflare gets the variable; PR CI, test builds and a
  GitHub Pages fallback build never do (`deploy_contract.py check-workflows` fails any other step or
  workflow that names it). Unset, the build is byte for byte what it is without analytics.
- Set, `index.html` gets the snippet once, before `</body>`. The `p/` and `s/` preview pages and the
  old address's pages only forward there, so they don't carry it and a visit counts once.
- Anything but 32 lowercase hex digits fails the build: the value is written into HTML.
- The snippet is sealed and compared like every other byte; nothing is stripped or special-cased.
- Browser checks that load the real site (staging checks, the production smoke) answer the beacon
  script's exact address with an inert stand-in, so they aren't counted as visits; any other request
  to Cloudflare's analytics hosts is still refused. The site sends no Content Security Policy today;
  if one is added, it must allow `https://static.cloudflareinsights.com/beacon.min.js` in
  `script-src` and `https://cloudflareinsights.com` in `connect-src`.
- The beacon is Cloudflare's script, loaded unpinned from its host, and runs with full access to the
  page, browser storage included: saves and the player's signing key. Turning analytics on trusts
  Cloudflare with that, as hosting already does. [POLICIES.md](POLICIES.md) says what it collects.

## Release evidence

Deploys are automatic on pushes to `main`, and only the owner may use the administrator bypass. This
checklist is evidence to record in the release PR or incident for the owner/operator's judgement, not
an approval gate:

- Exact candidate/merged commit SHA, Actions run, actual production URL and host, and on Cloudflare
  the Pages project (`CLOUDFLARE_PROJECT`, default `brainrottcg`) and deployment ID. Record public
  configuration, never tokens.
- Results at that revision: `npm run check`, `npm run build`, independent Python verification and
  relevant browser/storage/asset checks, real-device evidence (or that none was gathered; emulation
  is labelled as emulation), plus unrun checks and unresolved blockers. The
  [deploy workflow](../.github/workflows/deploy.yml) runs the independent Python verifier first and
  builds (`npm run check`, `npm run build`) and deploys only if it passes. The build job holds no
  secrets and seals what it built; the Cloudflare job publishes only those sealed files. With
  [staging](#staging) on, those same files are tested on staging first, and the run summaries of
  `stage` and `publish` record that both served every sealed file unchanged. Only the
  last job may write Pages. Deploys of `main` run one at a time (one `pages-<ref>` concurrency group
  per ref, so a run from another branch can't cancel one of `main`): a newer push to `main` cancels
  an older run, and the site job stops any run not started from `main`. The publish
  and deploy jobs each first check that the run's commit is still the tip of `main`, so re-running a
  run whose commit `main` has moved past fails rather than publishing an older build over a newer
  one. A failed check can leave the site stale: a `[skip ci]` merge that lands mid-run starts no new
  run (on Cloudflare, publish may already have gone out without the Pages redirect), and re-running
  an old run can cancel the latest one before failing itself. If no newer deploy run is in progress,
  start the workflow on `main` by hand (Actions > Deploy to GitHub Pages > Run workflow). The check
  compares commits, not runs: Hall of Fame refreshes start several runs on the same commit, each
  building in the Hall of Fame list of its time, so re-running an earlier one (or just its deploy
  job) still passes and serves that older list until the next refresh. Their inputs are one-day
  artifacts, so a re-run more than a day later must re-run all jobs, starting from build.
  [scripts/deploy_contract.py](../scripts/deploy_contract.py) does the sealing and checks, and CI's
  workflow lint runs its test, which reads these promises from the workflow files. Its strictness is
  deliberate: it fails closed, so any drift between the workflow and the contract fails CI until
  both are changed together.
  [CI](../.github/workflows/ci.yml) and [browser tests](../.github/workflows/browser-tests.yml) skip
  pushes to `main` (`branches-ignore`), so on a bypassed revision workflow lint (actionlint) and
  browser tests may not have run.
- Reviewer/operator, decision and known-good rollback target, plus any observed blockers: save loss
  or corruption, broken historical verification, persistent blank screens or missing assets, or
  inaccessible opening controls. Unresolved ones stay listed.
- For storage/proof/set changes, fixture evidence that the rollback target can read data written by
  the candidate, including identity, ticket/set/version history, pending packs and IndexedDB. Keep
  private backups offline; a public profile link cannot recover the secret key. Do not test with a
  player's only save or claim an export includes data it does not serialize.

### Release blocker criteria and promotion eligibility

`config/release-blockers.json` records confirmed release blockers and their current disposition.
`scripts/release-blockers.ts` decides eligibility for one exact candidate:
`npx tsx scripts/release-blockers.ts --candidate <sha> [--base <ref>] [--corrective-target <issue>]`
(`--base` defaults to `origin/main`).
It reads the record from the candidate's own tree and prints the record's sha256. Nothing consumes
it yet: enforcement lands with the promotion gate (#706), so today it is advisory and does not by
itself stop a deploy.

**What blocks release (narrow scope):** confirmed save loss or identity mixing (`save_loss`),
broken historical-proof compatibility (`broken_proof`), a persistent startup blank screen
(`startup_blank`), and core actions that can't be reached (`inaccessible_core`). Cosmetic issues,
optional features and missing device benchmarks are not blockers; never add an entry from an issue
title, label or count. Each entry records affected revisions, scenario, canonical issue, severity
rationale, owner, required evidence and a classification: `regression`, `older_defect`,
`unverified_hypothesis` or `missing_device_evidence`.

**Authority:** the record changes only through reviewed PRs to main. Issues, comments, labels and
author assertions can't change release permission. The CLI always compares the candidate's record
with the base's and blocks dropping an entry that wasn't resolved, rewriting an entry's issue or
category, and any entry whose disposition, mitigation or corrective-release block differs from the
base. The candidate may only move an entry to `unresolved` or `resolved`; an exception or corrective
release must be on main first. A base that doesn't resolve or has a malformed record fails closed
(fetch full history); a base commit without the record counts as an empty record. Resolved history
stays in the issue and PR, so resolved entries may be pruned.

**Dispositions** (anything missing, malformed or unverifiable fails closed):
- `unresolved`: blocks promotion.
- `resolved`: the fix PR, its full fix commit SHA, which must be in the candidate's history, and a
  regression test path present in the candidate. The candidate's full test run is the passing
  final-candidate regression.
- `mitigated_exception`: scope, rationale, mitigation evidence, follow-up issue, and an approval by
  evanlin23 that links the specific decision (`approvalRef`), lasting at most 30 days. The owner's
  general work approval never counts as accepting a specific critical failure.
- `corrective_release`: lets one candidate that fixes this blocker ship while other blockers stay
  tracked. It needs non-worsening and compatibility evidence and an approval by evanlin23, linked as
  above, for the exact reviewed commit (`approvedCommit`). The candidate must be that commit or a
  descendant that changes only `config/release-blockers.json` (the commit recording the approval);
  any other change makes the approval stale. It applies only when the run declares
  `--corrective-target` for this issue. There is no generic bugfix bypass.

## Recover on the same origin

Claude performs rollbacks, following this runbook (owner decision, 2026-10-17). No live rollback or
deploy rehearsal has been run, so the steps below are untested. Step 2 needs Cloudflare dashboard
access; without it, ask the owner for that step.

Do not delete hosting secrets or change the domain as a rollback
([switching hosts](#switching-back-to-github-pages) is a separate decision): browser saves belong to
their origin, so players can lose access to progress without a tested transfer. Keep the canonical URL, base path
and migration origins consistent with the selected release.

1. Record the failing SHA/run/deployment and current ranking snapshot; choose a known-good production
   deployment whose storage readers, proof versions and released sets/assets remain compatible.
   If the older app would erase/misread newer saves or omit a newly released set/version, use a small
   forward fix instead. Do not ask players to clear site data to make an older build work.
2. On Cloudflare, verify the recorded successful production deployment's commit/build identity, then
   roll back to it in the recorded Pages project's dashboard. Preview deployments are not targets;
   see [Cloudflare's rollback instructions](https://developers.cloudflare.com/pages/configuration/rollbacks/).
   This selects the previous deployed files on the same project; it does not revert Git, browser data
   or the GitHub Pages redirect deployment.
3. Keep all released set definitions, verifier rules and required card/preview assets available
   ([set versioning](ADDING_A_SET.md#changing-a-released-set)). An incompatible old deployment is not a
   safe target merely because it once worked. If no compatible deployment exists, prepare a feature
   PR against current main that reverts the faulty behavior while retaining those contracts. Do not
   reset or force-push main. Rebuilding a recorded commit is a new artifact, not a byte-identical rollback.
4. Reconcile the source with a follow-up PR promptly: automatic deployments remain enabled, and a later
   push or workflow run can replace the provider rollback. The Hall of Fame workflows also run
   `gh workflow run deploy.yml`: [hall-of-fame.yml](../.github/workflows/hall-of-fame.yml) when a
   submitted pull verifies and wasn't already verified on that issue, or when a run stopped between
   the bot's verified comment and the labels (that comment is still the bot's latest) and the next
   build would list the pull while the published list doesn't. Editing an issue away from its pull
   and back never redeploys. Any edit to an already-verified issue restores its labels without a new
   comment, unless it carries `rejected`. With neither `verified` nor `daily` left, it gets
   `verified` if the pull makes the all-time list (judged without the issue's own entry), else
   `daily` (also when the published list can't be read), whatever day it was first verified. And
   [hall-of-fame-inbox.yml](../.github/workflows/hall-of-fame-inbox.yml)
   when a run (dispatched about every 15 minutes) files new entries. Land the forward-fix PR first, or
   pause those workflows, before they redeploy a bad `main`. Avoid overlapping recovery and deploy
   runs; the workflow's concurrency group does not serialize dashboard rollbacks.

Cloudflare's deployment history is the artifact rollback source. On its Cloudflare path, the workflow
uploads only the GitHub Pages **redirect** directory (`pages/`) as `github-pages`; it does not archive
Cloudflare's `dist/` (the one-day `cloudflare-site-N` handoff between jobs is not a rollback source).
Never upload that redirect artifact as the game. When GitHub Pages is the actual
host, use the compatible feature-PR/forward-fix path above; there is no rollback command in this workflow.

UI and ranking recovery are separate decisions. A provider rollback also restores its bundled
`hall-of-fame.json`, which can omit newer winners or reintroduce moderated entries. Keep verified issue
records/moderation intact, retain the current snapshot for comparison, and rebuild ranking data from
current trusted evidence with compatible code. Do not undo submissions or rejected labels to match an
old UI. The GitHub redirect's copy may differ until refreshed; record that explicitly.

## Read-only checks after deployment or recovery

Every deploy ends with these checks in its `smoke` job (bounded to 15 minutes, no secrets, a
read-only token), once publish and deploy are done. `scripts/production-smoke.ts` makes the GETs
below. On Cloudflare it first asks for the marker until it names this run's own `sha` and `run_id`
(every 6 seconds, at most 10 times, while the edge still serves an older run or doesn't answer),
and fails at once on a newer run or another address; nothing else is read before that, so no check
reads an older release. GitHub Pages has no marker, so its checks start once `deploy-pages` returns.
Then, once each with no retries, it checks each script and stylesheet the page names (JavaScript or
CSS, never HTML), that every ranking proof decodes and that the preview image decodes at its stated
size. If those pass, on Cloudflare it checks that the old address forwards (its page and an unknown
link both forward here, keeping the path and hash), serves the same Hall of Fame list, and that its
copy of a set page keeps production's link preview (`og:image` and its size), also once:
`deploy-pages` has returned by then, so a wrong answer is a fault, not lag. Then
`playwright.production.config.ts` runs the shared-pull smoke specs against production in a fresh
browser context: public proof fixtures, card and share pages, malformed links and every lazy
screen, with every write and every request to another origin refused, so nothing reaches a relay,
the Hall of Fame or analytics (Web Analytics' beacon script gets an inert stand-in, so the checks
aren't counted as visits). A failure turns the deploy run red. A last step always runs
(`production-smoke.ts --status`): it calls the release known-good only when both the HTTP and the
browser checks passed, and when one of them failed names the newest deploy run on `main` that
passed on an earlier commit as the rollback target, or says to fix forward when there is none. It
gives no verdict, and names no rollback target, when a check didn't finish (cancelled, since a newer
push to `main` cancels the run, or skipped after an earlier step failed), when `main` has moved past
this run's commit (read with `git ls-remote`, as the deploy's tip-of-main steps do), or when a check
failed while production's `deployment-id.json` names a newer run (a later deploy, perhaps of the
same commit), since production may then serve a newer release; re-running an old run's `smoke` job
can't mark an older commit known-good. A named rollback run may
predate these checks or have been a GitHub Pages run, so check its `smoke` job before trusting it
(see [Recover on the same origin](#recover-on-the-same-origin); otherwise fix forward on `main`).
Nothing is uploaded: traces stay on the discarded runner. Use the steps below after a dashboard rollback or
other recovery, which starts no deploy run.

Smoke check, GETs only (`curl -fsS`), each with a fresh `?run=<anything>` so no cache answers (as
the publish job does). Paths are relative to the site address: <https://brainrottcg.pages.dev/> (or
the recorded URL) on Cloudflare, <https://evanlin23.github.io/BrainrotTCG/> when GitHub Pages hosts
the game.

| GET | Passes when |
|---|---|
| `deployment-id.json` (Cloudflare only) | 200 JSON whose `url` is this address and whose `sha` and `run_id` match the deployment you expect (below) |
| the address itself | 200 HTML naming a hashed `assets/index-*.js` entry script |
| that entry script | 200, `text/javascript` or `application/javascript`, non-empty |
| `hall-of-fame.json` | 200 JSON |
| `s/genesis/` and `s/genesis/preview.jpg` (a set's preview page and its `og:image`) | 200 each, the image non-empty |

`deployment-id.json` names the run that last published, which need not be the release you are
checking: a later Hall of Fame refresh republishes the same `sha` from a new `run_id`, and a dashboard
rollback serves the marker of the deployment rolled back to. Expect the latest successful deploy run
on `main` (whose publish job already waited for this marker), or after a rollback the recorded
target's `sha` and `run_id`; any other value means the address serves something you didn't intend.
GitHub Pages builds no marker: there, match the commit against the latest successful deploy run's
`deploy` job. While Cloudflare hosts the game, the GitHub address serves only redirects: check its
`hall-of-fame.json` as above and that its page names the Cloudflare address.
None of this proves assets decode or the game works.
In a disposable browser context, open a known valid historical pull, a current-version
pull and a profile link, and check invalid-proof recovery, ranking freshness and the old URL's
forwarding. Use public test proofs, don't open new packs, submit, reset or import real saves, and
record the tested deployment and any failures.
