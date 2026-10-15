# Dependency advisories

Triage for #230 (first slice), run on 2026-10-15 against the lockfile on main at 9d806ff after a
frozen `npm ci`. `npm audit` reports 8 findings in 369 packages (4 high, 2 moderate, 2 low, 0
critical). `npm audit --omit=dev` reports 0 in the 16 production packages. The 34 findings quoted
in #230 on 2026-10-13 no longer apply. A finding is a package and can carry several advisories.
Owner of every row is evanlin23. Re-run both commands when the lockfile changes and update this
file.

## Exposure

All 8 packages are dev dependencies. None is in the production bundle, and nothing in `src/`,
`scripts/` or `tests/` imports one. `npm run dev` binds to localhost only: `vite.config.ts` sets no
`server.host`, and Vite 7.3.5 printed "Network: use --host to expose". CI runs ESLint and
`vite build` on repo files with a read-only token and no secrets; `deploy.yml` gives its Cloudflare
secrets only to the site-lookup and deploy steps. `hall-of-fame.yml` handles untrusted issue text
but runs `tsx` (esbuild 0.28.2, unaffected), so it never loads these packages.

## Findings and dispositions

| Package and GHSA IDs | Sev | Path | Why it isn't exploitable here | Disposition |
| --- | --- | --- | --- | --- |
| brace-expansion 1.1.12: GHSA-f886-m6hf-6m8v, GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895, GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p | high | eslint > minimatch 3.1.5 | Expands only our own globs | Lockfile refresh |
| flatted 3.3.3: GHSA-25h7-pfq9-p65f, GHSA-rf6f-7fwh-wjgh | high | eslint > file-entry-cache > flat-cache | Parses ESLint's own cache file | Lockfile refresh |
| js-yaml 4.1.1: GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh | high | eslint > @eslint/eslintrc | Config is `eslint.config.js`, so no YAML is parsed | Lockfile refresh |
| browserslist 4.28.1: GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g | high | @vitejs/plugin-react > @babel/core > @babel/helper-compilation-targets | Fixed queries, with no browserslist config or stats file in the repo | Lockfile refresh |
| @humanfs/node 0.16.7: GHSA-p498-v437-472g | moderate | eslint | ESLint doesn't use the recursive copy | Lockfile refresh |
| baseline-browser-mapping 2.10.0: GHSA-w5vr-8v7q-w6rv | moderate | @vitejs/plugin-react > ... > browserslist | Same fixed inputs as browserslist | Lockfile refresh |
| @babel/core 7.29.0: GHSA-4x5r-pxfx-6jf8 | low | @vitejs/plugin-react, eslint-plugin-react-hooks | Reads source maps only from our own source | Lockfile refresh |
| esbuild 0.27.3: GHSA-g7r4-m6w7-qqqr | low | vite | The advisory covers esbuild's own dev server on Windows, which Vite doesn't use | Vite update, then esbuild re-resolve |

`npm audit` reports `fixAvailable: true` for all 8, and none is applied here. A scratch run recorded
in #410 (against 3600c81) cleared the 7 transitive ones by refreshing 28 dev-only lockfile entries.
The esbuild one takes two steps. Vite 7.3.6 and later declare `esbuild ^0.27.0 || ^0.28.0`, but in a
scratch copy `npm install vite@7.3.7 --package-lock-only` left esbuild at 0.27.3 and the audit at 8.
The affected range is 0.27.3 to 0.28.0, so esbuild must re-resolve to 0.28.1 or later:
`npm update esbuild --package-lock-only` gave 0.28.2 and an audit of 7. It isn't upstream-blocked;
that held only for Vite 7.3.5.

## Follow-ups

1. One lockfile refresh PR for the 7 transitive findings, tested alone with a frozen install.
2. One Vite update PR (7.3.6 or later) that also re-resolves esbuild to 0.28.1 or later. It is
   done when `npm audit` no longer reports esbuild.

Dependabot's version updates change direct dependencies only, and its open PRs (#390, #392, #397)
are major bumps, not fixes for these, so neither step waits on it. Never use
`npm audit fix --force`.
Revisit when either PR lands, and escalate any finding that shows up in `--omit=dev`.

Open: `.github/dependabot.yml` (#283) covers root npm, `tools/wrangler` npm and github-actions
with no Renovate overlap, but has no `groups:` block.
Open: the separate `tools/wrangler` lockfile wasn't audited.
