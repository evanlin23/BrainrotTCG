# Repository size

Why a clone is heavy, how to get a lighter one, and what is still undecided (#806). Numbers below
were measured on 2026-10-22 at `964bee6` (main) from a cloud container, all in MiB (1 MiB = 1048576
bytes). They show proportions; times vary with the network. Re-run the commands to refresh them.

## Baseline

| What | Size |
| --- | --- |
| Full clone, all history (1530 commits, 326 branches, 461 on `main`, 6107 blobs) | 227.6 MiB, 5.6 s |
| Shallow clone (`--depth=1`) | 125.3 MiB `.git` + 131.5 MiB working tree on disk, 3.3 s |
| Working tree (tracked files, by file size) | 128.4 MiB in 1370 files |

Where the working tree goes:

| Path | Size | Files | Read by |
| --- | --- | --- | --- |
| `src/content/sets/*/art/` (PNG source art) | 73.2 MiB | 127 | `npm run cards` and `/new-set` (draw the cards), `scripts/cards/prompts.ts`, and the "placeholder SVG art" guard in `npm run check` (`scripts/check-sets.ts`, through `findArt`) |
| `src/content/sets/**/*.webp` (served cards, finish thumbs, packs) | 45.1 MiB | 655 | the build, tests and `check:card-assets` |
| everything else (code, docs, tests, spec, audio, fonts, screenshots) | about 10 MiB | | |

Where the history goes (blobs by path, compressed): `src/assets` 46.6 MiB, mostly full-size images that
have since been replaced (the tree now holds 1.3 MiB there), then the per-set `art/` PNGs and the WebP
cards. PNG is 119.5 MiB of the history and WebP 93.6 MiB. Old blobs are only removable by rewriting
published history, which is not on the table (see below).

Branches are not the weight: a clone of `main` alone (461 commits) is also about 227 MiB, so the 326
branches add almost nothing and deleting them (#710) would not shrink a clone. The weight is `main`'s own
history.

CI is not where the weight hurts: most jobs run `actions/checkout` at its default depth 1, so each pays
the 125 MiB shallow clone (a few seconds), and the checks that follow take minutes. Two other patterns
are already in use: the burn-in plan job in `browser-tests.yml` fetches full history with
`filter: blob:none` (the blobless recipe below), and two `deploy.yml` jobs check out only the scripts
they need with `sparse-checkout`. Nothing in the workflows was changed for this.

Art only grows. Leaving out genesis (23.0 MiB of art), a set adds about 5-7 MiB of art PNG (2.7-6.9 MiB,
mean 5.6) and 4.0-4.5 MiB of served WebP (mean 4.2), about 10 MiB a set, and history about as much.

## Lighter checkouts (reversible)

Nothing below touches the repository, its history or its files; each is undone with one command.

To build, run the tests and work on code, without the PNG source art:

```sh
git clone --filter=blob:none --no-checkout https://github.com/evanlin23/BrainrotTCG
cd BrainrotTCG
git sparse-checkout set --no-cone '/*' '!/src/content/sets/*/art/'
git checkout main
```

Add `--depth=1` to the clone for a shallow one. Bring the art back with `git sparse-checkout disable`.

Without `art/`, `npm run check` is not the whole check. `scripts/check-sets.ts` asks `findArt` (in
`scripts/cards/lib.ts`) for each card's art, and with no `art/` folder it finds none, so its "released set
still has placeholder SVG art" guard passes without testing anything. CI checks out everything and is
authoritative. Run `git sparse-checkout disable` before editing or adding a set, and before relying on a
local `npm run check` for anything that touches `src/content/sets` or the card scripts.

| Clone | Time | `.git` | Working tree |
| --- | --- | --- | --- |
| shallow, everything (`--depth=1`) | 3.3 s | 125.3 MiB | 131.5 MiB |
| shallow, blobless, no `art/` (above plus `--depth=1`) | 2.9 s | 52.2 MiB | 58.0 MiB |
| full history, blobless, no `art/` (above) | 2.7 s | 53.9 MiB | 58.0 MiB |
| full history, everything | 5.6 s | 227.6 MiB | 131.5 MiB |
| full history, blobless, nothing checked out | 0.8 s | 1.9 MiB | 0 |

Times are the clone plus checkout. Blobless means file contents are fetched when a checkout or `git show`
needs them, so history stays browsable (`git log`, `git blame`) at about a quarter of the full size. In
the no-`art/` checkout, with `node_modules` from `npm ci` linked in, `npm run check` passed (3 min, with
the placeholder-art guard blind as described above) and `npm run build` succeeded (2.5 min). Disabling
sparse checkout afterwards fetched the art in about 2 s.

To refresh the baseline (note the commit you measured, `git rev-parse --short HEAD`):

```sh
git clone --bare https://github.com/evanlin23/BrainrotTCG full.git && du -sk full.git     # full history, KiB
git clone --bare --filter=blob:none https://github.com/evanlin23/BrainrotTCG b.git         # history only
git clone --depth=1 https://github.com/evanlin23/BrainrotTCG s
du -sk s/.git && du -sk --exclude=.git s                                                    # shallow: .git, tree
git -C full.git rev-list --objects --all | git -C full.git cat-file \
  --batch-check='%(objecttype) %(objectsize:disk) %(rest)' | awk '$1=="blob"'              # blobs by size
git ls-files -z | xargs -0 stat -c '%s %n'                                                  # tracked file sizes
```

Divide KiB by 1024 for MiB. Count with `git rev-list --count --all`, `git for-each-ref refs/heads | wc -l`
and `git rev-list --count main`.

## Not done, and why

These all need the owner, because each moves or rewrites something permanent. None is started.

- **Rewriting history** to drop old images (the `src/assets` blobs above): rewrites published
  history and every clone. Not allowed here.
- **Git LFS**: keeps the workflow, but moving files already committed into LFS only shrinks history if
  it is rewritten. It also needs `lfs: true` on each `actions/checkout` that reads the art (the sparse
  deploy checkouts read scripts only), and sits inside GitHub's LFS storage and bandwidth quotas, which
  grow with each set and each CI run that fetches the art. Needs the owner's decision on cost.
- **Art out of the repo** (object storage or the CDN the site deploys through, with an in-repo manifest):
  the cards are immutable per set version, which suits it. It is a new product and credentials.
  [HOSTING.md](HOSTING.md) tells the owner to create the Cloudflare token with Pages edit only and says
  its actual scope can't be checked from the repo, so the owner would confirm it; if it is Pages-only,
  object storage needs a new product and a wider or second token. It also needs upload and fetch steps
  in `check:card-assets` and the build, and a plan for provenance (`CREDITS.md`) and rebuilding old sets. Needs the owner's
  access and cost decision.
- **Dropping the PNG source art from the tree**: it is the provenance of each released card. Moving
  it elsewhere belongs with the option above, not on its own.

A measured proposal, if the owner wants one: the `art/` PNGs are 73.2 MiB of the 128.4 MiB tree and are
read only by the card scripts and one check, so they are the whole case for an external store; the WebP
the game serves is 45.1 MiB and stays in the repo either way. Even then the 227 MiB of existing history
stays for everyone who clones it in full, which is what the blobless recipe above avoids without any
decision.
