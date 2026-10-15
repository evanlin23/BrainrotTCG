# Hosting

The site is static files: no server, nothing to scale. It's built and deployed by
`.github/workflows/deploy.yml` to one of two free hosts.

| | Address | Cost | Limits |
|---|---|---|---|
| GitHub Pages | `evanlin23.github.io/BrainrotTCG` | Free, never billed | Soft limit of 100 GB of traffic a month; past it GitHub may slow the site or ask you to move |
| Cloudflare Pages | `brainrottcg.pages.dev` | Free, no card needed, never billed | None for static files: traffic and requests are unmetered |

Either way, nothing on the free plans can charge you: there's no payment method to charge.

## Moving to Cloudflare Pages

About five minutes, all in your browser:

1. Make a free Cloudflare account at <https://dash.cloudflare.com/sign-up>. Don't add a payment method.
2. Copy your **Account ID**: in the dashboard, open **Workers & Pages**; it's in the right-hand column.
3. Make an **API token**: profile icon → **My Profile** → **API Tokens** → **Create Token** →
   **Create Custom Token**. Give it one permission, **Account → Cloudflare Pages → Edit**, then
   **Continue to summary** → **Create Token**, and copy it (it's shown once).
4. In this repository on GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**. Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with those two values.
5. In Cloudflare **Workers & Pages**, create a **Pages** project using **Direct Upload**, named
   `brainrottcg` (or set the repository variable `CLOUDFLARE_PROJECT` to your project name). The
   workflow discovers an existing project's `pages.dev` address with a read-only API request;
   it no longer creates projects while deciding how to build. This owner setup has not been
   performed or verified by the draft PR.
6. After review/merge, a push to `main` or a workflow dispatch **on main** deploys automatically.
   Do not dispatch a feature branch to publish it.

The workflow uses Cloudflare when both secrets are present and the configured project can be
read. Missing credentials, an unavailable project or a failed lookup preserve the GitHub Pages
fallback. It publishes the site at the discovered address (or `SITE_URL`), checks that address
serves the exact source/run/attempt marker sealed into the selected build, and only then publishes old-origin forwarding. A custom `SITE_URL`
must be a root HTTPS URL without credentials, a port, query or fragment.

What keeps working:

- **Old links and QR codes.** Every page at the old address forwards to the same place at the new
  one: pull links, profile links and link-preview pages (which keep their card preview).
- **Saves.** A save lives in the browser's storage for the address it was made on, and it holds the
  player's secret key. When a player with a save opens any old link, the old address offers
  **Bring my save and go**: one tap opens the new address in a small window and the two hand the
  save over directly (`scripts/redirect-site.ts`, `src/game/move.ts`). Each side checks the other's
  origin, which browsers enforce, so no other site can plant or take a save, and the save never goes
  in a URL (URLs end up in browser history and history sync). Players who arrive through a new link
  can do the same from **Settings → From the old address**. If a player already has a different save
  at the new address, they're asked first and the replaced save is kept as a backup.
- **The Hall of Fame.** The old address keeps serving `hall-of-fame.json` for the scripts, and the
  issue links it files redirect like any other link.

## Your own domain later

Domains cost money (about $10–15 a year), so this is optional, and it's best decided before the
move: saves only carry over from the GitHub Pages address, not from `pages.dev` to a domain added
later. To use one, add it in Cloudflare (**Workers & Pages → brainrottcg → Custom domains**), set a
repository **variable** (not a secret) `SITE_URL` to it, ending in `/` (for example
`https://brainrottcg.net/`), and deploy.

## Deployment trust boundary

The deployment graph is `exact source → independent vectors → read-only host discovery →
unprivileged check/build → immutable artifact → privileged publish`. Both hosting paths consume
the same run's sealed files; forwarding pages and previews are generated before production
credentials are available. Publication checks repository, case-sensitive main ref, supported event,
source SHA, run ID/attempt, the build's manifest digest and every packaged file hash. It refuses
an artifact from another build or an outdated main revision. Failed, skipped or cancelled required
jobs cannot publish. The publisher checks current main before publication and again before changing
the old address. GitHub/Cloudflare do not offer an atomic cross-provider transaction: a new commit
arriving during an in-flight publication can still require the next automatic deployment to finish.

Only the discovery/publish jobs reference Cloudflare secrets; discovery performs GET only and
executes no checked-out source. Build has read-only contents/issues access. Publication alone has
Pages/OIDC write permissions. The pinned publishing CLI is installed without credentials or package
scripts; no application build is run with production secrets. Only eligible main publishers enter the
non-cancelling production concurrency group, so a rejected branch dispatch cannot cancel main.

Both credential-bearing jobs name the existing `github-pages` environment. **YAML cannot configure
its branch restrictions, secret scope, branch protection or repository Actions policy.** The owner
must retain its main-only restriction. Repository-scoped Cloudflare secrets remain accessible to old
workflow revisions that reference them; this PR cannot retroactively secure those revisions. A later
owner-reviewed move to main-restricted environment secrets can remove that residual access. This
change does not move/delete secrets, add approval gates, disable automatic deployment or alter the
owner's administrator bypass. Environment/discovery permissions and live deployment remain untested.

Run `python3 -m unittest discover -s scripts -p 'deploy_contract_test.py'` for offline source,
artifact, provider and workflow-boundary fixtures. CI and deployment build run this gate. No fixture
makes network calls or publishes. Browser/workflow gates from other PRs must be reconciled into the
final deployment graph after those jobs land; this graph currently requires `npm run check`, the
build, these fixtures and the independent Python vectors, not proposed future checks.

## Undoing a move

Changing the active origin is not a same-origin code rollback: browser saves stay at their original
origin. Do not delete secrets or switch hosts as an emergency code rollback after players settle in.
Review save/export compatibility and use a known compatible artifact at the same origin; keep old
proof/set assets available. Any host reversal needs its own save-preserving migration plan.
