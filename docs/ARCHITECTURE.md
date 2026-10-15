# Architecture

Brainrot TCG is a static site (Vite + React on GitHub Pages) with **no backend**. Every pull is
still verifiable by anyone, because packs are derived from proofs rather than stored anywhere.

## Verification at a glance

No server decides what anyone pulled. Your device does a fixed amount of work per pack and signs the
result; anyone's device redoes the same work from the link and gets the same pack. Opening and
verifying are the same function, `derivePack(set, key, ticket#)`.

```mermaid
flowchart LR
  subgraph You["Your device"]
    K["Player key (Ed25519, stays local)"]
    N["Ticket counter #0, #1, ..."]
    T["Ticket: Argon2id(set@v, key, #n), 32 MiB"]
    P["Pack: SHA-256 -> sfc32 -> 5 cards"]
    H["Pack history (every ticket)"]
    S["Sign"]
    K --> T
    N --> T --> P --> H --> S
    K --> S
  end
  Sets[("Card sets: published, hash-locked, old versions kept")]
  Sets -. rules .-> P
  S -->|"#/pull/proof or #/profile/proof"| L(["Link, shared anywhere"])
  subgraph Viewer["Anyone's device"]
    D["Strict decode"] --> C["Name, key, signature"] --> R["Redo the ticket(s)"] --> V{"Same pack? Claims match?"}
  end
  L --> D
  Sets -. same rules .-> R
  V -->|yes| OK["Verified"]
  V -->|no| BAD["Rejected, naming the rule"]
```

GitHub only hosts the site and keeps the Hall of Fame list; public Nostr relays carry submissions from
players without a GitHub account. Either could drop a submission, but every visitor re-checks the
entries, so neither can add a fake one. `spec/verify_pull.py`
re-implements all of this from the spec with different libraries, and CI checks both implementations
against both sets of test vectors.

## Layers

```
src/engine/        Pure TypeScript. No React, no DOM, no Vite. Runs in the browser, a Web Worker and Node (CI).
  pack.ts            seeded PRNG + deterministic pack generation (integer-only odds)
  ticket.ts          Argon2id proof-of-work: the cost of one pack
  identity.ts        Ed25519 player keys, fingerprints, name rules
  proof.ts           pull proofs: encode / decode / sign / verify
  scoring.ts         Brainrot Score: rarity points x combo multipliers, all derived from the odds
  odds.ts            exact combo odds for any set (powers the in-game scoring guide)
  hallOfFame.ts      what qualifies for the Hall of Fame (shared by UI and CI)

src/content/       Data. Adding content never needs code changes.
  sets/<set>/set.json  cards (id, name, rarity, caption, flavor, art brief), odds, holo odds
  sets/<set>/art/      source art (real images, full cards, or SVG placeholders)
  sets/<set>/cards/    built card images (npm run cards); committed
  sets/<set>/finish-thumbs/  small ready-made metallic finishes for the collection; committed
  sets/<set>/pack.webp the set's booster pack wrapper, built from its colours and rarest cards
  sets/index.ts        the registry: every version of every set (old versions and archived sets stay for old proofs)
  sets.lock.json       hash of each released set@version (npm run check:sets)

src/game/          Browser glue around the engine.
  player.ts          the local player key, name and ticket counter (localStorage)
  ticketMiner.ts     mines tickets in workers/ticket.worker.ts, pre-mining the next pack
  pulls.ts           openPack(), proofFor(), pullUrl(), checkPull()
  share.ts, bragImage.ts   brag text, Hall of Fame submit, 9:16 pull poster and player card with QR
  progression.ts     titles, card backs, pack foils, collection milestones, set completion
  shareActions.ts    copy the link or image (the system share sheet only on phones)
  previewLinks.ts    link previews: shared links go through a static page per hand and its cards
  hallOfFameList.ts  the published Hall of Fame list, loaded once per visit
  nostrInbox.ts      Hall of Fame submissions over public Nostr relays (loaded only when used)
  move.ts            hands a save over from the site's old address, window to window (docs/HOSTING.md)

src/components/    React UI (pack opening, collection, set picker, share sheet, pull viewer, pages)

spec/              The proof spec (PULL_SPEC.md), test vectors, and verify_pull.py: an independent
                   Python verifier written only from the spec. CI runs both verifiers on both vector files.

scripts/           Node tools (run with tsx)
  cards/             card compositor (Genesis frame + art + text), pack wrappers, previews, prompt sheets
  check-sets.ts      set lock guard
  hall-of-fame.ts    verifies Hall of Fame issues; files Nostr submissions; builds public/hall-of-fame.json
  hof-inbox.ts       the inbox rules: verify, dedupe, budget, retry
  preview-pages.ts   after the Vite build: a preview picture and page for every hand each set can make
  redirect-site.ts   the old address after a move: forwards every link and brings saves along
```

## How a pull works

```
player key (Ed25519)  ─┐
set@version           ─┼─► Argon2id ticket (≈0.1–0.5 s of work) ─► SHA-256 ─► sfc32 PRNG ─► 5 cards + holos
ticket number (nonce) ─┘
```

- Opening a pack consumes the next ticket number. The ticket is mined in a Web Worker while the
  previous pack is still on screen, so players never wait.
- A **proof** is `(set, version, public key, nonce, name)` signed with the player's key: about 130
  bytes, base64url-encoded into `#/pull/<proof>` links.
- **Verifying** means recomputing the ticket and the pack from the proof. Nothing can be edited:
  changing any byte breaks the signature, and the cards are never part of the proof (they're re-derived).

### Why proof-of-work

Without a server nobody can witness pack openings, so the game can't stop players choosing which
pulls to show. It can make every pull **cost the same as opening a pack**: searching for a lucky
pack is just opening packs. Argon2id is memory-hard, which keeps the advantage of GPUs and big
machines small compared to plain hashing.

Known limits: you can't prove how many packs someone opened in total, or that they weren't using a
bot. A ticket takes about 0.1 s, so a script finds a Full House in seconds and a 5 of a Kind in
minutes of CPU. "Verified" means *these cards really came from this player's ticket*, not that a
person was lucky; the Hall of Fame ranks world firsts by when the GitHub bot verified them for that reason.

A security review (Oct 2026) found and fixed a forgery via small-order Ed25519 keys and malleable
encodings; the rules that close them are in `spec/PULL_SPEC.md` section 7 and covered by the vectors.

## Hall of Fame (no server)

There are two ways in. Most players don't have a GitHub account, so the default needs none.

```
player ─► Share ─► "Submit"  ─► signed Nostr event ─► 5 public relays
                                                          │  every 15 minutes (Cloudflare cron)
                    .github/workflows/hall-of-fame-inbox.yml
                    scripts/hall-of-fame.ts inbox  ─► bot-filed issue + comment + labels (+ redeploy)
                                   │
player ─► Share ─► "on GitHub" ─► GitHub issue form (pull link; needs an account)
                                   │
                    .github/workflows/hall-of-fame.yml
                    scripts/hall-of-fame.ts verify-issue  ─► comment + labels (+ redeploy)
                                   │
                    .github/workflows/deploy.yml
                    scripts/hall-of-fame.ts build  ─► public/hall-of-fame.json (top 100 + firsts)
                                   │
                    Hall of Fame page re-derives each entry again in the visitor's browser
```

**Without an account** (`src/game/nostrInbox.ts`): the game wraps the pull proof in a Nostr event
(NIP-78 application data, kind 30078, so it never shows up in anyone's feed), signs it with a
throwaway key made for that one submission, and sends it to five open relays. The throwaway key is
only a transport: who pulled it comes from the proof's own signature. The inbox job reads the last
week of events, checks each event's signature, verifies the pull with the same engine as everything
else, and files the ones that qualify as issues in the same verified state the GitHub path ends in.
Each run checks at most 300 pulls and files at most 20, skips pulls already verified in the list,
and remembers events it has checked (in the Actions cache) so junk isn't re-checked every run;
anything over the limits waits for the next run. It keeps paging each relay back to the start of the
window, so a burst of junk can't push a real submission out of reach, and keeps only copies whose
signature checks out, so one bad relay can't hide another's good copy. Only the exact proof text a
link carries is accepted, so what's filed always reads back as the same pull. A filing that stops
halfway (issue opened, not yet labelled `verified`) is finished on the next run.
It costs nothing: the relays are free, and Actions minutes on a public repository are free.
GitHub's own schedule for the inbox is best effort and has never fired for this repository, so a
Cloudflare Worker with a cron trigger (`workers/hall-of-fame-cron/`, also free) starts the workflow
every 15 minutes; the schedule stays as a backup, and runs never overlap. If neither runs, nothing is
lost: submissions show in the Hall of Fame straight from the relays, and any run picks up the last
week's.

A relay can drop a submission (that's why there are five) or flood the inbox with junk (each run
checks a bounded number, and junk is skipped), but it can't forge an entry: the deploy and every
visitor re-derive each pull from its proof. A maintainer can drop an entry the same way as any other
(the `rejected` label below).

**One list, any size.** The Hall of Fame is the top 100 pulls by Brainrot Score plus the first Full
House, 4 of a Kind and 5 of a Kind in each set: about 120 entries however many people play. The rules
live in `src/engine/hallOfFame.ts` and decide it everywhere: the share sheet only offers Submit for a
pull that would join, the inbox and the issue verifier read the deployed list and file only pulls that
would join, and the deploy writes only the list. Verified issues are closed (the deploy reads every
state), so the issue list holds only what needs attention. Deploys keep each verified issue's result
in the Actions cache, keyed on the engine, the sets and the script: an issue unchanged since the last
deploy isn't verified or read again, so a deploy's work grows with new submissions, not all of them.

Issue text is untrusted: it's only parsed by the script, never put into a shell command, and only
echoed back through a sanitiser. The submitter's GitHub username comes from GitHub. "World first"
order uses the time the bot first verified that exact pull on the issue (a marker in its comment), not
the issue's creation date, so a placeholder issue edited later can't claim an earlier spot. Each pull
counts once, however many times it's submitted or re-signed. A maintainer can drop an entry by adding
the `rejected` label to its issue.

## Sharing and link previews

Sharing copies: the link, or the poster image (the system share sheet appears only on phones). A pull
link carries its whole proof, which is what makes it checkable anywhere without a server, and also
why it's long; the proof is about 170 characters and can't get much shorter.

Chat apps build a link preview from the page address alone, and the proof is after the `#`, which
they never see. So a copied link goes through a static page for the pack's hand and the cards that
make it, `p/<code>.html#/pull/<proof>` (the code is 8 hex characters of
`sha256("set/card+card/HAND")`, fixed forever). Its picture is the pack as five cards: those cards
face up as many times as the hand has them, the rest face down. A Full House is the whole pack, Two
Pair both pairs, 3 or 4 of a Kind or a Pair the matching card, and No Matches the best card. A card
shared on its own gets a page with just that card (`sha256("set/card")`).

Drawing the exact pack of every pull would need a server; drawing every hand each set can make is
about 2,200 pictures (about 300 MB). `scripts/preview-pages.ts` writes them after the Vite build, with
pages titled like "A Full House in Summer of Slop", and keeps the pictures in `.cache/previews/`
(cached in CI too) so only new or changed ones are drawn. The pages forward to the pull. The path only
picks the preview; the pull is still re-derived from the proof when it's opened.

## Hosting

Static files on GitHub Pages, or on Cloudflare Pages once two secrets are set; both free with
nothing to bill. See `docs/HOSTING.md`, including how old links and saves follow a move (saves go
window to window with origin-checked postMessage, never in a URL).

## Profiles and levels (no server)

A profile link (`#/profile/<proof>`, spec section 11) is the player's signed list of which set every
ticket went to, from ticket #0 with no gaps, plus two claims: their XP and their five best tickets.
It carries no cards; the viewer re-opens every pack (`src/game/profiles.ts`), so nothing in it can be
edited, and bad packs can't be left out (a ticket's pack is fixed, and every ticket is listed).

Speed, for a profile of N packs (each pack is one ~0.1 s ticket):

- the signature and the claimed level: instant;
- the best pulls: about a second (re-opened first);
- everything: N tickets across a pool of workers (`src/game/ticketPool.ts`, up to 8). If the packs
  don't match the claims, the profile is marked fake;
- a second view, or the same profile with more packs: only the new packs (`src/game/reopenCache.ts`).

The game records every pack the moment it's derived (`src/game/history.ts`), and signs profiles from
that history, so sharing one is instant. Levels come from the packs alone (spec section 11.3), so a
level is exactly as trustworthy as the packs.

The collection, stats and achievements take a pack only once its reveal ends (so a toast can't spoil
a card still face down). Until then the pack also waits in `brainrot-pending-pack-v1`
(`src/game/pulls.ts`): a reload, a closed tab or the opener unmounting mid-reveal can't lose it, since
the app adds a waiting pack on the next load. Screens pass a pulled card whole, with its holo, finish
and misprint (`src/game/versions.ts`), rather than those as separate props, so none can drop one.

### Progression

Nothing can change what a pack holds (any luck bonus would let a script skip ahead, since every
ticket costs the same), so progression is everything else, worked out from the packs
(`src/game/progression.ts`), which makes it as checkable on someone else's profile as their level:

- **Levels** unlock a title (shown next to the level), card backs and pack foils (cosmetic, picked
  under Profile → Level rewards; applied as `data-card-back` / `data-pack-foil` on `<html>`).
- **Collection score**: the points of every card pulled, holos at holo points, with named milestones
  (Bronze 1,000 up to Brainrot 2,000,000).
- **Sets**: each set is *Complete* with every card and *Master* with every card as a holo, shown on
  the set picker and profiles, with an achievement for each.
- **Player card** (`src/game/playerCard.ts`): a 9:16 image of all this plus the best pull, with a QR
  code for the profile link.

### Card modifiers

Besides rarity and holo, cards in a set version with `"modifiers": 1` roll a **finish** (Silver 10%,
Gold 2.5%, Platinum 0.5%, Diamond 0.1%) and a **misprint** (0.5%), and every one multiplies the card's
points by about 1 / its chance (x10, x40, x200, x1000, x200), stacking with holo (spec section 5.4).
They're derived from the ticket like everything else, so they're as checkable as the cards. Only set
versions that opt in roll them, so no pull from before changed: version 1 of each set has no
modifiers and keeps verifying exactly as it did; version 2 (the same cards) adds them, and new packs
open from it. Finishes recolour the card's printed frame (silver gray, gold yellow, platinum blue,
diamond blue/violet), with glow on platinum and diamond; misprints show off-register colours
(`src/game/modifiers.ts`), in the collection, history, Hall of Fame and the share poster, and they're
stored compactly in the pack history (`src/game/cardCode.ts`: `sigma*G!` is a holo Gold misprint).

`src/game/frameRecolor.ts` uses the shared frame's alpha mask to protect the meme artwork. Large
card views and the PNG exporter use `src/game/finishImage.ts`, caching full-size results per card/finish.
Collection tiles load pre-rendered 344px WebP finishes directly, with native lazy loading and no
canvas recolouring or PNG encoding on first load. They use the same recolouring function before
resizing. `npm run cards` rebuilds these thumbnails and the small lossless mask
(`src/assets/images/card-frame-mask.webp`); `npm run cards:finish-thumbs` refreshes just the thumbnails.
Input hashes include the source image, mask, recolouring code and output settings, so changed cards
or finishes regenerate their thumbnails while unchanged assets are skipped.

## Invariants (CI enforces these)

1. **Released sets never change.** Card ids, order, rarities, odds or pack size of a released
   `set@version` can't change; bump `version` and keep the old file (`npm run check:sets`).
2. **Engine changes that alter packs need a new ticket or proof version.** The engine and the
   independent Python verifier must both pass every vector in `spec/` (`src/engine/spec.test.ts` and
   the `independent-verifier` CI job).
3. **Every card has a built image** (`npm run cards`).

Run everything with `npm run check`.

## Local agent task audits

`npm run audit:agent -- --task=opening --seconds=90` runs a local disposable audit on Unix with Node 22, authenticated **Codex CLI 0.159.2**, `npm ci`, and the lockfile's Chromium (`npx playwright install chromium`). Other CLI versions fail closed pending capability review. This is separate from normal CI; `npm run check` and Actions need no agent account. Optional tasks are `--task=sharing`, `--task=results`, and `--task=recovery`. Start with one task: your provider may charge, and elapsed time is not a currency cap.

The coordinator requires committed tracked files, rebuilds that exact revision and owns a strict-port Vite preview at 127.0.0.1:4197. Each task gets a fresh deterministic disposable identity/context and an empty agent working directory. Prompts contain the task only, without product history, source or expected labels/routes. These are fresh-user fixtures, not existing-profile coverage. The restricted MCP adapter offers visible accessibility snapshots, exact button/link clicks and navigation keys; no evaluation, arbitrary URL, files or saves. User config/rules, shell, extra browsers, apps/plugins and delegation tools are disabled. The CLI stays read-only; this is a constrained audit, not an OS sandbox for arbitrary hostile model output.

The browser blocks external HTTP/WebSockets, POSTs, service workers, forms, popups, clipboard/native share, downloads and named export/import/submit controls. Local opening changes only disposable state. Sharing tasks may be blocked at this deliberate boundary; this does not establish that native sharing works. The coordinator never posts findings, merges or deploys.

Tasks run sequentially: at most four, each 30–180 seconds and 40 browser calls; build limit 300 seconds. Ctrl-C cancels owned child process groups, contexts and server. `test-results/agent-audit.json` records the tested SHA, actual conditions/steps, agent outcome, generic errors, sanitized observations and explicit limitations. Invalid reports, missing tools/provider, timeout or cancellation exit nonzero as incomplete/unrun; completion needs recorded browser interaction. Raw provider output, screenshots, auth, private storage and exports are not retained. Review even sanitized prose before attaching it to a PR.

The report includes a separate coordinator prompt for reproducing/deduplicating findings against existing issues and retesting affected tasks without coaching. Agent outcomes/timings are not human statistics and do not replace real phones, native share, screen readers or newcomers. Refs #239; canonical contributor guidance is being consolidated in #315/#216.
