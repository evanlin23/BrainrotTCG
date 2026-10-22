# Repository size

Why a clone is heavy, how to get a lighter one, and what is still undecided (#806). Numbers below
were measured on 2026-10-22 at `13b3eaf` from a cloud container; they show proportions, and times vary
with the network. Re-run the commands to refresh them.

## Baseline

| What | Size |
| --- | --- |
| Full clone, all history (1512 commits on 321 branches, 6013 blobs) | 227 MiB pack, 4.6 s |
| Shallow clone (`--depth=1`) | 126 MiB `.git` + 132 MB working tree, 3.5 s |
| Working tree (tracked files) | 134.5 MB in 1368 files |

Where the working tree goes:

| Path | Size | Files | Needed by |
| --- | --- | --- | --- |
| `src/content/sets/*/art/` (PNG source art) | 76.8 MB | 127 | only `npm run cards` and `/new-set`, which draw the cards from it |
| `src/content/sets/*/cards/`, `finish-thumbs/`, packs (WebP, served) | 48.1 MB | 660 | the build, tests and `check:card-assets` |
| everything else (code, docs, tests, spec, audio, fonts, screenshots) | about 10 MB | | |

Where the history goes (blobs by path, compressed): `src/assets` 48.8 MB, mostly full-size images that
have since been replaced (the tree now holds 1.4 MB there), then the per-set `art/` PNGs and the WebP
cards. PNG is 125 MB of the history and WebP 98 MB. Old blobs are only removable by rewriting
published history, which is not on the table (see below).

Branches are not the weight: a clone of `main` alone (457 commits) is also 227 MiB, so the 321 branches
add almost nothing and deleting them (#710) would not shrink a clone. The weight is `main`'s own history.

CI is not where the weight hurts: `actions/checkout` is already depth 1, so each job pays the 126 MiB
shallow clone (a few seconds), and the checks that follow take minutes. Nothing in the workflows was
changed for this.

## Lighter checkouts (reversible)

Nothing below touches the repository, its history or its files; each is undone with one command.

Everything `npm run check` and `npm run build` need, without the PNG source art:

```sh
git clone --filter=blob:none --no-checkout https://github.com/evanlin23/BrainrotTCG
cd BrainrotTCG
git sparse-checkout set --no-cone '/*' '!/src/content/sets/*/art/'
git checkout main
```

Add `--depth=1` to the clone for a shallow one. Bring the art back (needed to draw cards, see
[ADDING_A_SET.md](ADDING_A_SET.md)) with `git sparse-checkout disable`.

| Clone | Time | `.git` | Working tree |
| --- | --- | --- | --- |
| shallow, everything (`--depth=1`) | 3.5 s | 126 MiB | 132 MB |
| shallow, blobless, no `art/` (above plus `--depth=1`) | 3.1 s | 53 MiB | 58 MB |
| full history, blobless, no `art/` (above) | 3.1 s | 54 MiB | 58 MB |
| full history, everything | 4.6 s | 227 MiB | 132 MB |
| full history, blobless, nothing checked out | 0.8 s | 1.9 MiB | 0 |

Blobless means file contents are fetched when a checkout or `git show` needs them, so history stays
browsable (`git log`, `git blame`) at about a quarter of the full size. In the no-`art/` checkout, with
`node_modules` from `npm ci` linked in, `npm run check` passed (3 min) and `npm run build` succeeded
(2.5 min). Disabling sparse checkout afterwards fetched the art in about 2 s.

To refresh the baseline:

```sh
git clone --bare https://github.com/evanlin23/BrainrotTCG full.git && du -sh full.git     # full history
git clone --bare --filter=blob:none https://github.com/evanlin23/BrainrotTCG b.git         # history only
git clone --depth=1 https://github.com/evanlin23/BrainrotTCG s && du -sh s/.git s          # shallow
git -C full.git rev-list --objects --all | git -C full.git cat-file \
  --batch-check='%(objecttype) %(objectsize:disk) %(rest)' | awk '$1=="blob"'              # blobs by size
git ls-files -z | xargs -0 stat -c '%s %n'                                                  # tracked file sizes
```

## Not done, and why

These all need the owner, because each moves or rewrites something permanent. None is started.

- **Rewriting history** to drop old images (the `src/assets` blobs above): rewrites published
  history and every clone. Not allowed here.
- **Git LFS**: keeps the workflow, but adds a storage and bandwidth dependency on the host, and moving
  files already committed into LFS only shrinks history if it is rewritten. Needs the owner's decision
  on cost and on the host's LFS limits.
- **Art out of the repo** (object storage or the CDN the site deploys through, with an in-repo manifest):
  the cards are immutable per set version, which suits it, but it needs a provider, credentials,
  upload and fetch steps in `check:card-assets` and the build, and a plan for provenance (`CREDITS.md`)
  and rebuilding old sets. Needs the owner's access and cost decision.
- **Dropping the PNG source art from the tree**: it is the provenance of each released card. Moving
  it elsewhere belongs with the option above, not on its own.

A measured proposal, if the owner wants one: the `art/` PNGs are 77 MB of the 132 MB tree and are read
by one script, so they are the whole case for an external store; the WebP the game serves is 48 MB and
stays in the repo either way. Even then the 227 MiB of existing history stays for everyone who clones
it in full, which is what the blobless recipe above avoids without any decision.
