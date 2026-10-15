# Dependency advisories

Triage record for #230, first slice. Run on 2026-10-15 against the lockfile on main at 9d806ff,
after a frozen `npm ci` on Node 22. Nothing here changed a dependency or the lockfile.

| Command | Findings | High | Moderate | Low | Critical |
| --- | --- | --- | --- | --- | --- |
| `npm audit` (full tree, 369 packages) | 8 | 4 | 2 | 2 | 0 |
| `npm audit --omit=dev` (16 production packages) | 0 | 0 | 0 | 0 | 0 |

The 34 findings quoted in #230 on 2026-10-13 are gone from this lockfile. Each finding below is a
package, and a package can carry several advisories. Owner for every row is evanlin23.

## Exposure

- **Production bundle:** none. All 8 packages are dev dependencies, and `src` imports none of them.
- **Dev server:** no. `vite.config.ts` sets no `server.host`, so `npm run dev` binds to localhost
  only. Vite 7.3.5 printed `Local: http://localhost:5199/` and "Network: use --host to expose".
- **CI:** low. `ci.yml` runs `npm ci`, ESLint and `vite build` on repo files with a read-only token
  and no secrets. `deploy.yml` runs the same tools on main, and its Cloudflare secrets reach only
  the site-lookup and deploy steps. `hall-of-fame.yml` handles untrusted issue text but runs
  `tsx`, which uses esbuild 0.28.2, so it never loads the packages below.
- **Scripts:** they run under `tsx`, and no file in `scripts/`, `src/` or `tests/` imports an affected package.

## Findings

| Package and GHSA IDs | Sev | Path from a top-level dependency | Exposure |
| --- | --- | --- | --- |
| brace-expansion 1.1.12: GHSA-f886-m6hf-6m8v, GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895, GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p | high | eslint > minimatch 3.1.5 | ESLint only, expanding our own globs |
| flatted 3.3.3: GHSA-25h7-pfq9-p65f, GHSA-rf6f-7fwh-wjgh | high | eslint > file-entry-cache > flat-cache | ESLint reading its own cache file |
| js-yaml 4.1.1: GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh | high | eslint > @eslint/eslintrc | Config is `eslint.config.js`, so no YAML is parsed |
| browserslist 4.28.1: GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g | high | @vitejs/plugin-react > @babel/core > @babel/helper-compilation-targets | Babel, with no browserslist config or custom stats file in the repo |
| @humanfs/node 0.16.7: GHSA-p498-v437-472g | moderate | eslint | ESLint doesn't use the recursive copy |
| baseline-browser-mapping 2.10.0: GHSA-w5vr-8v7q-w6rv | moderate | @vitejs/plugin-react > ... > browserslist | Same fixed inputs as browserslist |
| @babel/core 7.29.0: GHSA-4x5r-pxfx-6jf8 | low | @vitejs/plugin-react, eslint-plugin-react-hooks | Reads source maps from our own source |
| esbuild 0.27.3: GHSA-g7r4-m6w7-qqqr | low | vite | The advisory covers esbuild's own dev server on Windows, which Vite doesn't use |

## Fixes and dispositions

`npm audit` marks all 8 with a non-force fix (`fixAvailable: true`, no major bump). I didn't apply
any. Seven are transitive lockfile refreshes inside existing ranges. The esbuild one needs Vite
7.3.6 or later, which allows `esbuild ^0.28.0` (checked with `npm view`); `package.json` already
allows `vite ^7.3.5`. The esbuild row in the DEVELOPMENT.md audit table calls this
upstream-blocked, which was true only for Vite 7.3.5.

Dependabot's weekly version updates change direct dependencies only, and the three open Dependabot
PRs (#390, #392, #397) are major bumps rather than fixes for these. Waiting for Dependabot won't
clear the transitive packages, so the disposition for all 8 is a tracked upgrade: one lockfile
refresh PR for the seven transitive ones, then one Vite patch update for esbuild, each tested alone
with a frozen install. Both are later slices of #230. Never use `npm audit fix --force`.

Revisit when the lockfile changes or either update lands. Re-run both audits and update this file.
Escalate any finding that appears in `--omit=dev` output, or any dev finding whose package starts
running on untrusted input.

## Dependabot config

`.github/dependabot.yml` (#283) covers npm for `/` and `/tools/wrangler` plus github-actions, with
no `groups:` block (one PR per package, capped at 3, 1 and 2 open) and no Renovate config in the
repo, so the two bots don't overlap. No ecosystem is missing, so I left it unchanged. The
`tools/wrangler` lockfile wasn't audited in this slice.
