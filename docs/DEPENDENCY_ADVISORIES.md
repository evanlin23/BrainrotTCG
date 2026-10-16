# Dependency advisories

Tracks #230. Owner of every row is evanlin23. Re-run `npm audit` and `npm audit --omit=dev` at the
root and in `tools/wrangler` whenever a lockfile changes, and update this file.

## Current state

Re-run on 2026-10-16 on main (7233d12) after a frozen `npm ci`; the counts below were taken on 2026-10-15. A finding is a package and can carry several advisories.

| Lockfile | Before (main at bd55082) | After the lockfile refresh |
| --- | --- | --- |
| Root, `npm audit` | 8 in 369 packages (4 high, 2 moderate, 2 low) | 0 in 343 packages |
| Root, `npm audit --omit=dev` | 0 in 16 production packages | 0 |
| `tools/wrangler`, both commands | 0 in 91 packages | 0 (unchanged) |

Nothing remains open: the 2026-10-16 re-run reports 0 for both commands at the root and in `tools/wrangler`. The 34 findings quoted in #230 on 2026-10-13 were already gone by the first
triage (#413, at 9d806ff).

## Fixed findings

All 8 were dev dependencies: none is in the production bundle, and nothing in `src/`, `scripts/` or
`tests/` imports one. `npm run dev` binds to localhost only (`vite.config.ts` sets no
`server.host`). CI runs ESLint and `vite build` on repo files with a read-only token and no secrets.
`hall-of-fame.yml` handles untrusted issue text but runs `tsx`, which already used esbuild 0.28.2.

| Package and GHSA IDs | Sev | Path | Exposure | Fixed at |
| --- | --- | --- | --- | --- |
| brace-expansion: GHSA-f886-m6hf-6m8v, GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895, GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p | high | eslint > minimatch 3.1.5 | Lint in CI and locally; expands only our own globs | 1.1.12 to 1.1.21 |
| flatted: GHSA-25h7-pfq9-p65f, GHSA-rf6f-7fwh-wjgh | high | eslint > file-entry-cache > flat-cache | Lint; parses ESLint's own cache file | 3.3.3 to 3.4.4 |
| js-yaml: GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh | high | eslint > @eslint/eslintrc | Lint; config is `eslint.config.js`, so no YAML is parsed | 4.1.1 to 4.3.2 |
| browserslist: GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g | high | @vitejs/plugin-react > @babel/core > @babel/helper-compilation-targets | Build and dev server; fixed queries, no browserslist config | 4.28.1 to 4.29.3 |
| @humanfs/node: GHSA-p498-v437-472g | moderate | eslint | Lint; ESLint doesn't use the recursive copy | 0.16.7 to 0.16.8 |
| baseline-browser-mapping: GHSA-w5vr-8v7q-w6rv | moderate | @vitejs/plugin-react > ... > browserslist | Build and dev server; same inputs as browserslist | 2.10.0 to 2.11.29 |
| @babel/core: GHSA-4x5r-pxfx-6jf8 | low | @vitejs/plugin-react, eslint-plugin-react-hooks | Build, dev server and lint; reads only our own source maps | 7.29.0 to 7.29.7 |
| esbuild: GHSA-g7r4-m6w7-qqqr | low | vite | Build and dev server; covers esbuild's own dev server on Windows, which Vite doesn't use | 0.27.3 to 0.28.2, with Vite 7.3.5 to 7.3.7 |

The fixes were in-range lockfile updates (`npm update <name> --package-lock-only`, one name per
call), plus a Vite floor bump to `^7.3.7` so Vite's esbuild could reach 0.28.x. No `overrides`, no
`npm audit fix --force`. Main has since moved to Vite 8 and ESLint 10 (`package.json`: `vite ^8.3.4`,
`eslint ^10.12.0`), which replaced the vulnerable minimatch 3 and brace-expansion 1 paths; the table
records what was fixed then, and the audit stays clean on the new tree (esbuild 0.28.2, browserslist
4.29.3, flatted 3.4.4).

## Wrangler

Kept: it is used. `tools/wrangler` pins Wrangler 4.149.0 in its own lockfile for one job,
`deploy.yml` on pushes to main, and only when the Cloudflare secrets are set (docs/HOSTING.md). That
job installs it with `npm ci --prefix tools/wrangler --ignore-scripts` and runs
`wrangler pages deploy dist` with the Cloudflare token. It isn't in the app's dependencies, the dev
server, PR CI or the production bundle. `workers/hall-of-fame-cron/README.md` mentions
`npx wrangler` only as an optional manual deploy path. Its lockfile reports 0 findings.

## Decisions

- **Dev-tool findings:** all 8 fixed (table above). None reached production.
- **TypeScript 7 (#392):** closed by the owner. No advisory needs it; main stays on `^5.9.3`.
- **Vite 8 and ESLint 10:** adopted on main; no open advisory.
- **Production and `tools/wrangler`:** 0 findings. Escalate at once any finding that shows up in
  `npm audit --omit=dev` or in `tools/wrangler`.

## Update automation

`.github/dependabot.yml` covers the root npm lockfile (grouped `dev-tooling` and `prod`, with
`hash-wasm` and `@noble/*` as separate PRs), `tools/wrangler`, and GitHub Actions (grouped). Every
`uses:` in `.github/workflows` is already pinned to a SHA, so nothing was added. Security advisories
open Dependabot PRs on their own; each gets review and green CI before merging
(docs/DEVELOPMENT.md).
