# Dependency advisories

Tracks #230. Owner of every row is evanlin23. Re-run `npm audit` and `npm audit --omit=dev` at the
root and in `tools/wrangler` whenever a lockfile changes, and update this file.

## Current state

Re-run on 2026-11-03 on main (1b1562b) after a frozen `npm ci`. A finding is a package and can carry
several advisories. The refresh is one in-range lockfile change, `npm update zod`.

| Lockfile | Before (main at 1b1562b) | After the lockfile refresh |
| --- | --- | --- |
| Root, `npm audit` | 13 in 337 packages (1 high, 12 moderate) | 12 (12 moderate) |
| Root, `npm audit --omit=dev` | 0 | 0 |
| `tools/wrangler`, both commands | 0 in 91 packages | 0 (unchanged) |

Production and `tools/wrangler` are clean. The 12 moderate findings left at the root are all one
advisory, listed under "Open findings" below. Before this, the 2026-10-16 re-run (main at 7233d12)
reported 0 everywhere; the new findings appeared as advisories were published, not from a lockfile
change. The 34 findings quoted in #230 on 2026-10-13 were already gone by the first triage (#413, at
9d806ff).

## Open findings

One advisory, GHSA-g3hv-75wg-m249 (minimatch before 11.0.1, denial of service through globparts
amplification), reaches 12 packages because they all depend on minimatch 10.2.6: minimatch itself,
eslint, @eslint/config-array, @eslint/js, @eslint-community/eslint-utils, eslint-plugin-react-refresh,
typescript-eslint, @typescript-eslint/eslint-plugin, parser, type-utils, utils and typescript-estree.

- **Dev-only exposure:** none of these is in the production bundle or in `tools/wrangler`. minimatch
  runs in ESLint (locally and in CI) to match our own file globs from `eslint.config.js` and in
  typescript-estree for our own tsconfig globs. No untrusted pattern reaches it.
- **Why not fixed:** the newest releases inside `package.json`'s ranges still depend on minimatch 10:
  eslint 10.14.0 (`^10.2.6`), @eslint/config-array 0.23.5 (`^10.2.4`) and typescript-estree 8.72.1
  (`^10.2.2`); minimatch 11.0.4 is out, but nothing that depends on it has shipped. npm's suggested
  fix (@eslint/js 9.39.5, typescript-eslint 8.36.0) is a downgrade and was not taken. The only fix
  today is an `overrides` entry forcing minimatch 11 under ESLint, which was not added: it would run
  ESLint on a major its maintainers have not tested.
- **What would fix it:** an ESLint or typescript-eslint release that depends on minimatch 11.0.1 or
  later. Re-run the audit when Dependabot's `dev-tooling` PR lands one.

## Fixed findings

The zod finding (GHSA-mrhx-c7xc-m3w5, high; memory exhaustion validating oversized constrained
collections) was fixed on 2026-11-03 by moving zod 4.3.6 to 4.6.7 in the lockfile. It is dev-only: zod
comes in through eslint-plugin-react-hooks and zod-validation-error, and nothing in `src/`, `scripts/`
or `tests/` imports it.

The 2026-10-16 refresh fixed 8 findings. All 8 were dev dependencies: none is in the production bundle, and nothing in `src/`, `scripts/` or
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

- **Dev-tool findings:** the 8 from October and the zod finding are fixed. The minimatch advisory is
  open (see "Open findings"). None reached production.
- **No overrides:** none is in use. Add one only if a finding cannot be cleared any other way, and
  record it here.
- **TypeScript 7 (#392):** closed by the owner. No advisory needs it; main stays on `^5.9.3`.
- **Vite 8 and ESLint 10:** adopted on main; the audit was clean on them in October; the minimatch 10 path is the open finding.
- **Production and `tools/wrangler`:** 0 findings. Escalate at once any finding that shows up in
  `npm audit --omit=dev` or in `tools/wrangler`.

## Update automation

`.github/dependabot.yml` covers the root npm lockfile (grouped `dev-tooling` and `prod`, with
`hash-wasm` and `@noble/*` as separate PRs), `tools/wrangler`, and GitHub Actions (grouped). Every
`uses:` in `.github/workflows` is already pinned to a SHA, so nothing was added. Only the weekly
version updates run: Dependabot security-update PRs are off unless the owner enables them, so
advisories show up in the Security tab and `npm audit`. Every Dependabot PR gets review and green CI
before merging (docs/DEVELOPMENT.md).
