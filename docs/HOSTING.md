# Hosting

The site is static files: no server, nothing to scale. It's built and deployed by
`.github/workflows/deploy.yml` to one of two free hosts.

| | Address | Cost | Limits |
|---|---|---|---|
| GitHub Pages (now) | `evanlin23.github.io/BrainrotTCG` | Free, never billed | Soft limit of 100 GB of traffic a month; past it GitHub may slow the site or ask you to move |
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
5. **Actions → Deploy to GitHub Pages → Run workflow** (or push anything to `main`).

The deploy then creates the Cloudflare Pages project `brainrottcg`, publishes the site at its root,
checks that the new address serves this exact build, and only then turns the old address into a
redirect. The run's log shows the new address (if `brainrottcg` is taken, Cloudflare adds a suffix).

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

## Release evidence

Deploys remain automatic on pushes to `main`; administrator bypass remains available. This checklist
records release/recovery evidence, not a new approval workflow. In the release PR or incident, record:

- Exact candidate/merged commit SHA, Actions run and actual production URL, host, Cloudflare project
  (`CLOUDFLARE_PROJECT`, default `brainrottcg`) and deployment ID. Record public configuration, never tokens.
- Results at that revision: `npm run check`, `npm run build`, independent Python verification and
  relevant browser/storage/asset checks; name unrun checks and unresolved blockers. The current
  [deploy workflow](../.github/workflows/deploy.yml) runs check/build, but not the separate
  [CI independent verifier](../.github/workflows/ci.yml); do not assume it ran on a bypassed revision.
- Reviewer/operator, decision and known-good rollback target. Save loss/corruption, broken historical
  verification, persistent blank screens/assets or inaccessible opening controls block a normal release;
  an emergency bypass must state what remains unverified.
- For storage/proof/set changes, fixture evidence that the rollback target can read data written by
  the candidate, including identity, ticket/set/version history, pending packs and IndexedDB. Keep
  private backups offline; a public profile link cannot recover the secret key. Do not test with a
  player's only save or claim an export includes data it does not serialize.

## Recover on the same origin

Do not delete hosting secrets or change the domain as a rollback: browser saves belong to their origin,
so players can lose access to progress without a tested transfer. Keep the canonical URL, base path
and migration origins consistent with the selected release.

1. Record the failing SHA/run/deployment and current ranking snapshot; choose a known-good production
   deployment whose storage readers, proof versions and released sets/assets remain compatible.
   If the older app would erase/misread newer saves or omit a newly released set/version, use a small
   forward fix instead. Do not ask players to clear site data to make an older build work.
2. For Cloudflare, open **Workers & Pages → the recorded Pages project → Deployments → All deployments**.
   Find the recorded successful production deployment, verify its commit/build identity, then use its
   three-dot menu → **Rollback to this deployment** and confirm. Preview deployments are not targets;
   see [Cloudflare's rollback instructions](https://developers.cloudflare.com/pages/configuration/rollbacks/).
   This selects the previous deployed files on the same project; it does not revert Git, browser data
   or the GitHub Pages redirect deployment.
3. Keep all released set definitions, verifier rules and required card/preview assets available
   ([set versioning](ADDING_A_SET.md#changing-a-released-set)). An incompatible old deployment is not a
   safe target merely because it once worked. If no compatible deployment exists, prepare a feature
   PR against current main that reverts the faulty behavior while retaining those contracts. Do not
   reset or force-push main. Rebuilding a recorded commit is a new artifact, not a byte-identical rollback.
4. Reconcile the source with a follow-up PR promptly: automatic deployments remain enabled, and a later
   push or workflow run can replace the provider rollback. Avoid overlapping recovery and deploy runs;
   the workflow's `pages` concurrency group does not serialize dashboard rollbacks.

Cloudflare's deployment history is the artifact rollback source. On its Cloudflare path, the workflow
uploads only the GitHub Pages **redirect** directory (`pages/`) as `github-pages`; it does not archive
Cloudflare's `dist/`. Never upload that redirect artifact as the game. When GitHub Pages is the actual
host, use the compatible feature-PR/forward-fix path above; there is no rollback command in this workflow.

UI and ranking recovery are separate decisions. A provider rollback also restores its bundled
`hall-of-fame.json`, which can omit newer winners or reintroduce moderated entries. Keep verified issue
records/moderation intact, retain the current snapshot for comparison, and rebuild ranking data from
current trusted evidence with compatible code. Do not undo submissions or rejected labels to match an
old UI. The GitHub redirect's copy may differ until refreshed; record that explicitly.

## Read-only checks after deployment or recovery

At the recorded production URL, confirm the expected hashed entry script in `index.html` matches the
selected build and loads, then check required card images and a `/p/` preview page. The deploy workflow
checks the entry-script reference before updating the old-site redirect; that alone does not prove
assets decode or the game works. In a disposable browser context, open a known valid historical pull,
a current-version pull and a profile link, and check invalid-proof recovery, ranking freshness and the
old URL's forwarding. Use public test proofs, avoid opening new packs/submitting/resetting/importing real
saves, and record the tested deployment plus failures. These are follow-up checks, not a deployment.
