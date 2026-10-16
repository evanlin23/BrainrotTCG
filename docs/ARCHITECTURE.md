# Architecture

Brainrot TCG is a static Vite + React site, deployable to GitHub Pages or Cloudflare Pages, with
**no authoritative game backend**. Player state lives in browser storage; public pull proofs let
others independently derive the same cards. GitHub workflows and a configured Cloudflare cron
Worker handle submissions and publication, not pack generation.

## Verification at a glance

No server decides what anyone pulled. A ticket uses fixed Argon2id parameters for a set version,
public key and nonce; elapsed time depends on hardware. A signed pull link binds those inputs and
its name, and a verifier derives the same pack with `derivePack(set, key, ticket#)`. A valid proof
establishes that result and the signing key, not browser-only play, a human action or an opening time.

```mermaid
flowchart LR
  subgraph You["Your device"]
    K["Player key (Ed25519, stays local)"]
    N["Ticket counter #0, #1, ..."]
    T["Ticket: Argon2id(set@v, key, #n), 32 MiB"]
    P["Pack: SHA-256 -> sfc32 -> 5 cards"]
    H["Local pack history (best effort)"]
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

GitHub keeps verified submission issues used to build the Hall of Fame list; public Nostr relays
carry submissions from players without a GitHub account. Either can omit or delay submissions. The build verifies issues
(or reuses cached verification), while the Hall of Fame UI re-checks entries in the current top 30
one at a time; it does not re-verify the whole published list. Opening a pull link verifies its proof.
`spec/verify_pull.py` independently implements the proof spec with different libraries, and CI
checks both implementations against both sets of test vectors.

## Layers

```
src/engine/        Pure TypeScript. No React, no DOM, no Vite. Runs in the browser, a Web Worker and Node (CI).
  pack.ts            seeded PRNG + deterministic pack generation (integer-only odds)
  ticket.ts          Argon2id proof-of-work: the cost of one pack
  identity.ts        Ed25519 player keys, fingerprints, name rules
  proof.ts           pull proofs: encode / decode / sign / verify
  profile.ts         profile proofs: encode / decode / verify, XP and levels
  scoring.ts         Brainrot Score: rarity points x combo multipliers, all derived from the odds
  odds.ts            exact combo odds for any set (powers the in-game scoring guide)
  hallOfFame.ts      what qualifies for the Hall of Fame (shared by UI and CI)
  rankings.ts        ranking boards: one snapshot schema, Best packs and Best cards selectors

src/content/       Set data, art and registry; existing schemas use the existing engine.
  sets/<set>/set.json  cards (id, name, rarity, caption, flavor, art brief), odds, holo odds
  sets/<set>/art/      source art (real images, full cards, or SVG placeholders)
  sets/<set>/cards/    built card images (npm run cards); committed
  sets/<set>/finish-thumbs/  small ready-made metallic finishes for the collection; committed
  sets/<set>/pack.webp the set's booster pack wrapper, built from its colours and rarest cards
  sets/index.ts        the registry: every version of every set (old versions and archived sets stay for old proofs)
  sets.lock.json       hash of each released set@version (npm run check:sets)

src/game/          Browser glue around the engine.
  player.ts          the local player key, name and ticket counter (localStorage)
  ticketMiner.ts     serial opening-ticket queue, worker/main-thread fallback, next-pack prefetch
  ticketPool.ts      separate verification/reconstruction pool, up to 8 workers (32 MiB each)
  history.ts         compact localStorage ticket metadata/cards; quota can discard old records
  profiles.ts        signed profile construction, verification and background own-pack reconstruction
  packStore.ts       reconstructed own-pack card codes in memory and IndexedDB
  reopenCache.ts     localStorage cache for packs derived while viewing public profiles
  pulls.ts           openPack(), proofFor(), pullUrl(), checkPull()
  share.ts, bragImage.ts   brag text, Hall of Fame submit, 9:16 pull poster and profile card with QR
  progression.ts     titles, card backs, pack foils, collection milestones, set completion
  shareActions.ts    copy/download and API-supported coarse-pointer system sharing
  previewLinks.ts    link previews: shared links go through a static page per hand and its cards
  hallOfFameList.ts  the published Hall of Fame list, kept for the visit once loaded (a failed or
                     15-second load can be retried)
  nostrInbox.ts      Hall of Fame submissions over public Nostr relays (loaded only when used)
  move.ts            hands a save over from the site's old address, window to window (docs/HOSTING.md)
  saveFile.ts        save export and import: validate, back up, write, roll back on failure
  collectionRecovery.ts  keeps unreadable collection entries aside instead of overwriting them
  selectedSet.ts     the chosen pack set; the choice still works when it can't be saved
  route.ts           the page addresses (#/cards, #/rankings, #/profile, #/settings) and their titles

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
set@version           ─┼─► Argon2id ticket (32 MiB, 2 iterations) ─► SHA-256 ─► sfc32 PRNG ─► 5 cards + modifiers
ticket number (nonce) ─┘
```

- Opening mines the next ticket number's ticket, then claims that number, derives the cards and
  records the mapping, so a closed tab or failed miner spends no number while mining. Without Web
  Locks the claim and the mapping land in one task; with them only the claim's lock release sits
  between, so a tab closed in that instant can still leave a claimed number unmapped. If another tab
  took the number meanwhile, it records the claimed number's set first, then mines that one: a failed
  mine or a reload leaves a ticket a profile re-opens, not a gap. `ticketMiner.ts` queues work
  serially and prefetches the next ticket while a pack is shown. Prefetch can reduce waits, but slow
  devices, worker failures and competing work can still delay opening; fallback uses the main thread.
- A **proof** is `(set, version, public key, nonce, name)` signed with the player's key and
  base64url-encoded into `#/pull/<proof>` links; its size varies with those fields.
- **Verifying** means recomputing the ticket and the pack from the proof. Nothing can be edited:
  changing any byte breaks the signature, and the cards are never part of the proof (they're re-derived).

### Why proof-of-work

Without a server nobody can witness pack openings, so the game can't stop players choosing which
pulls to show. Every tested ticket must use the same configured derivation function, whether it is
opened in the UI or searched by a local miner. Argon2id is memory-hard, but this is not a rate limit:
parallel implementations, GPUs and more capable machines can search faster. There is no measured
hardware-fairness guarantee.

Known limits: a proof cannot establish how many tickets someone searched, that they used the
browser or that a human opened a pack. "Verified" means *these cards derive from the signed ticket
inputs*. Hall of Fame "world firsts" use the bot's verification time, not a witnessed opening time.

Strict key/signature validation and canonical encoding rules are specified in `spec/PULL_SPEC.md`
section 7 and covered by the vectors, including small-order key and malleable-encoding cases.

## Hall of Fame (no server)

There are two submission paths; the default relay path needs no GitHub account.

```
player ─► Share ─► "Submit"  ─► signed Nostr event ─► 5 public relays
                                                          │  configured 15-minute Cloudflare cron
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
                    Hall of Fame page checks current top 30; pull links verify individually
```

**Without an account** (`src/game/nostrInbox.ts`): the game wraps the pull proof in a Nostr event
(NIP-78 application data, kind 30078), signs it with a
throwaway key made for that one submission, and sends it to five open relays. The throwaway key is
only a transport: who pulled it comes from the proof's own signature. The inbox job reads the last
week of events, checks each event's signature, verifies the pull with the same engine as everything
else, and files the ones that qualify as issues in the same verified state the GitHub path ends in.
Each run re-derives at most 300 pulls and files at most 20. It remembers handled event IDs in an
Actions cache (latest 20,000) and skips already verified pulls. Fetching requests up to 50 pages of
100 events per relay within a 60-second connection deadline, over a seven-day window. These are
client request limits, not guarantees that relays return or retain every event or obey the limits.
Only valid event signatures are retained, and the exact proof text in the link is accepted. A filing
that stops after opening an issue can reuse that issue on retry. Deferred submissions are eligible
on a later run only while still available in the fetched window; cache eviction and service errors
can cause repeat work or missed submissions.

The inbox workflow has a best-effort GitHub schedule and a concurrency group that serializes inbox
runs. `workers/hall-of-fame-cron/` defines a 15-minute dispatch trigger when deployed and configured;
source configuration alone does not prove it is running. Public relays and eligible public-repository
Actions can be used without a game server, subject to provider limits and availability. If intake
stops, the UI may show pending relay pulls after checking up to ten candidates per visit (own
submissions first), but this does not guarantee delivery or later inclusion in the published list.

A relay can drop a submission (that's why there are five) or flood the inbox with junk (each run
limits expensive pull derivations, and junk is skipped). It cannot forge a valid signature or alter
what a valid ticket derives; server/build verification and the UI checks described above enforce
those proof rules, rather than delivery or mining fairness. A maintainer can drop an entry using
its issue's `rejected` label.

**Published list.** The Hall of Fame is the top 100 pulls by Brainrot Score plus the first Full
House, 4 of a Kind and 5 of a Kind in each set. The output is bounded by 100 plus three firsts per set,
with overlapping entries deduplicated; it grows with the number of sets. The rules
live in `src/engine/hallOfFame.ts`. The share sheet and intake test whether a qualifying pull would
join the available published snapshot; when it cannot be loaded, they fall back to qualification.
The deploy writes the ranked list. Workflows attempt to close verified issues, and the build reads
both open and closed states. Deploys keep each verified issue's result
in the Actions cache, keyed on the engine, the sets and the script. Unchanged issues can reuse their
verification result, but the build still lists verified issues across open and closed states; cache
misses, changed inputs and API failures affect work and freshness.

Issue text is untrusted: it's only parsed by the script, never put into a shell command, and only
echoed back through a sanitiser. The submitter's GitHub username comes from GitHub. "World first"
order uses the time the bot first verified that exact pull on the issue (a marker in its comment), not
the issue's creation date, so a placeholder issue edited later can't claim an earlier spot. Each pull
counts once, however many times it's submitted or re-signed. A maintainer can drop an entry by adding
the `rejected` label to its issue.

### Ranking boards (`src/engine/rankings.ts`)

This is an engine contract only (#223, #338). Nothing publishes or shows these boards yet, and the
Rankings page still reads `topPulls`. Every board is a `RankingSnapshot` with these fields:

- the schema version, scope and capacity;
- the `SCORING_ERA` its scores came from;
- completeness: complete, or partial with a reason;
- `certifiedThrough`: how far down the ranking the board holds every candidate there is;
- freshness: `generatedAt`, the latest first receipt, and source counts for candidates,
  duplicates, other eras and uncertain entries.

All boards use one order: score, then the earlier trusted first receipt, then pull id. Receipt
times are compared as instants (`receiptTime`), so GitHub's `…07Z` and a client's `…07.123Z` sort
correctly. Two equal cards in one pack rank the later slot first, the card `revealOrder` shows
last. The pack summary's `bestPullOrder` lists the earlier slot first instead; boards don't follow it.

| Board | Ranks | Identity | Size | Where |
| --- | --- | --- | --- | --- |
| Best packs (#223) | pulls by Brainrot Score | pull id | 100 | Rankings page |
| Best cards (#338) | card instances by their own points | `pullId#slot` | 10 | Rankings page |
| Best versions of this card (#224) | one card's instances | `pullId#slot` | - | card details |

Best packs and Best cards are tabs or sections of the existing Rankings page, not new primary nav
destinations. Best versions of this card opens from a card's details.

- **Evidence.** Inputs are verified pack reconstructions (`packEvidence` from `verifyProof`), never
  a client's score.
- **Card entries.** A card scores `cardPoints` before the combo multiplier. It carries its exact
  modifiers, set id and version, proof and slot.
- **Independent cutoffs.** One proof can feed both boards. A weak pack with one great card makes
  Best cards without making Best packs.
- **Scoring eras.** Eras are never merged. Bump `SCORING_ERA` whenever scoring changes any existing
  pull's points. A board holding older-era candidates is empty and partial (`scoring-changed`)
  until they are re-derived from their proofs.
- **Rebuilds.** `rebuildBoard` rebuilds from retained evidence after removals. Its coverage
  defaults to the previous board's `certifiedThrough`:
  - Exact with coverage `all`, when every candidate was kept.
  - With a winners-only cache, the board certifies only places at or above the previous bound. It
    comes back shorter and partial (`runners-up-not-retained`) rather than promoting runners-up
    it never kept. The bound is stored, so it survives removing every entry.
  - A `min-score` board stays partial (`below-intake-minimum`) unless a wider coverage is passed.
- **Intake minimum.** A pack scores at least each of its cards' points (`scorePack`: the combo
  multiplier is never below 1), so every card worth `HALL_OF_FAME_MIN_SCORE` or more sits in a
  pack that qualified. That bound holds only over every filed issue, not over the pruned
  `hallOfFameList`. It also holds only while the top 100 has room: once it fills, intake refuses
  packs that don't beat the 100th place, so the bound rises to just above the highest 100th-place
  score intake has enforced. Pass that as the `min-score` coverage; below it the board is partial
  (`below-intake-minimum`). So the card board lists only cards worth at least 20,000 and stays
  partial until intake has filed enough of them to fill it.
- **Daily boards** come later.

## Sharing and link previews

Sharing copies the link or poster image; a system share sheet is offered on coarse-pointer devices
when the browser supports it. A pull link carries its whole proof, making it independently checkable;
its length depends on the signed fields.

Chat apps build a link preview from the page address alone, and the proof is after the `#`, which
they never see. So a copied link goes through a static page for the pack's hand and the cards that
make it, `p/<code>.html#/pull/<proof>` (the code is 8 hex characters of
`sha256("set/card+card/HAND")`, fixed forever). Its picture is the pack as five cards: those cards
face up as many times as the hand has them, the rest face down. A Full House is the whole pack, Two
Pair both pairs, 3 or 4 of a Kind or a Pair the matching card, and No Matches the best card. A card
shared on its own gets a page with just that card (`sha256("set/card")`).

The deployed preview pages are generated ahead of time for the supported hands and cards, rather
than generated for each unique pull. Their count and size grow with the published content.
`scripts/preview-pages.ts` writes them after the Vite build, with pages titled like "A Full House in Summer of Slop", and keeps the pictures in `.cache/previews/`
(cached in CI too) so only new or changed ones are drawn. The pages forward to the pull. The path only
picks the preview; the pull is still re-derived from the proof when it's opened.

Addresses and Back (`src/hooks/useRoute.ts`, `src/hooks/usePackHistory.ts`): Open has no hash;
`#/cards`, `#/rankings`, `#/profile` (your own) and `#/settings` are pages. A shared
`#/pull/<proof>` or `#/profile/<proof>` opens its viewer sheet over whatever page is showing, and a
link that doesn't parse gets the broken-link sheet. Pages, opened packs and links share one history:
each pushes an entry marked in `history.state`, so Back from a page returns to the previous page or
to the pack it was opened over, Back from a pack leaves it, and closing a link or a page steps back
over the entries it added rather than replacing them, so no pack entry is stranded. A page or link
loaded directly has nothing under it, so closing it replaces the address with Open. Diagnostics
report the page by its allowlisted name, never the hash.

## Saves

localStorage keys are `STORAGE_KEYS` in `src/constants/config.ts`, plus `brainrot-player-v1`
(identity), `brainrot-data-version` (migrations), `brainrot-reopen-pending-v1`,
`brainrot-reopen-backoff-v1` (how long an automatic resume waits after re-opened packs couldn't be
saved) and `brainrot-reopened-v1` (profile re-opening), `brainrot-hof-submitted-v1` (Hall of Fame submissions),
`brainrot-save-stamp-v1` (changed by every import and move, so other open tabs can tell) and the
`brainrot-before-import-v1`, `brainrot-before-move-v1` and `brainrot-before-move-pending-v1` backups
(kept for recovery by hand: the app never restores a save from them). IndexedDB holds one database,
`brainrot-packs` (`packStore.ts`).
A failed foreground write shows a save warning and the game stays usable. Before the collection is
replaced, unreadable entries are archived byte for byte, with the identity snapshot they belonged to,
in `brainrot-collection-recovery-v1`: each distinct payload once, the first and then the newest 10,
within 1M characters (older ones in between are let go and counted). The archive never blocks the
save: a payload storage has no room for is kept for that visit only, and the note asks the player to
download it. Nothing discards kept-aside data silently; the player can download or discard it from the
save warning or Settings. Export includes that archive. Import
(`saveFile.ts`) validates every supplied field and the player first, then copies every `brainrot-*`
key except earlier `brainrot-before-*` backups to `brainrot-before-import-v1`, replacing an earlier
import's copy (with no such keys there is nothing to copy, and an earlier import's copy stays; if the
copy can't be stored, nothing is imported; a failed import keeps it). Fields the file omits keep their stored values, except that a
different player's save clears this browser's player fields (recovery archive included), which then
stay only in that backup. It clears those fields, writes a new `brainrot-save-stamp-v1` before any imported field, clears
them again (even ones that were absent, which a tab still on the old save may have just written), and writes the identity last; on failure it removes what it wrote and
restores the previous values. That is structural validation and best-effort rollback, not a
transaction. The
legacy `brainrot-pulls-v1` log is kept until its migration into history completes.
A render error after React mounts shows `AppErrorBoundary`, which writes nothing except the opt-in
diagnostics: `render-error`, and `copy-failed` if copying its report to the clipboard fails. Startup
steps before React mounts (`receiveSave`, `runMigrations`, `migratePullLog` in `main.tsx`) are
outside it and need their own handling.

## Hosting

`.github/workflows/deploy.yml` selects Cloudflare Pages when its account/token configuration works,
otherwise GitHub Pages; `BASE_PATH` and `SITE_URL` determine built paths and preview addresses. Both
have free static-hosting options, with provider build, storage, traffic and service limits; custom
domains or additional services can cost money. See `docs/HOSTING.md` for configuration and old-address
redirects. Save transfer (`move.ts`, `scripts/redirect-site.ts`) uses origin-checked
window-to-window postMessage, not URL contents. The old address never deletes its save: it sets
`brainrot-moved-v1` (a timestamp) once the new address reports `saved` or `same`, or once it sends
its save to Save & restore (`#/send`), and from then on old links go straight through without offering
the move. At the new address, the handed-over player and fields must pass the same checks as an
imported file, except for collection entries that storage keeps on purpose (first-format entries
migrations rebuild, and entries hydration hides for recovery) and best-pack cards in a save older
than v3 (checked as migrations and the profile read them), and a missing `brainrot-data-version`
is stored as `1` so the save's migrations run; otherwise the result is `invalid` and nothing is
written. Neither side's `brainrot-before-*` backups are handed over. Replacing a different
player's progress asks first and keeps a copy of the current save. `brainrot-before-move-v1` and
`brainrot-before-move-pending-v1` hold the two most recent distinct copies, never more:
`brainrot-before-move-v1` the older one (or the only one), the pending key the newer. Before taking
a copy, a move puts a pending copy in `brainrot-before-move-v1`'s place (one write, then it is
removed; the oldest copy goes), then copies the save here into the pending key, or into
`brainrot-before-move-v1` while there is no copy at all. So a copy is only ever written over by a
newer one taking its place, never by the end of a move. If either write fails, the save here is
unchanged (a pending copy already moved into place stays there) and the result is `full` (storage
quota) or `invalid`. No copy is taken when the newest one already holds the save here (every key
here matches that copy or the incoming save, or holds no progress, like a guest that opened no
packs): after a `partial` move it is whole where the save here may not be. Only the newest copy
counts, so two saves' keys are never taken for one, and a matching stamp or player alone isn't
enough, since packs opened since would be in neither copy. The move then removes that save's keys
(player and stamp first, so a tab still on it stops writing). After `saved` or `partial`, the newest
copy holds the save this move replaced and the older one the save before that. Into a browser
without progress, keys the save doesn't carry stay and no copy is taken. A failed write removes what
it wrote, restores the previous values and drops only the copy just taken, as the save it holds is
back in place (best effort, not a transaction), and the result is `full` (storage quota) or
`invalid`. If the values can't all be restored, the result is `partial` and every copy is kept: the
player is told this browser may hold parts of both saves, Save & restore then reloads so the page
shows what storage holds (a partial file import does the same), and the move window stays open on
any failure so its note can be read.

## Profiles and levels (no server)

A profile link (`#/profile/<proof>`, spec section 11) signs a declared contiguous range of tickets
from #0, the set version assigned to each, XP and up to five best tickets. The viewer derives that
range and checks the claims. It cannot prove that the range includes all lifetime mining activity,
that no other keys were used, or when packs were opened.

`src/game/profiles.ts` checks decoding/signature first, then derives highlights before the remaining
tickets and validates XP/highlights. A displayed claim is not verified merely because the signature
passes. Work uses `ticketPool.ts`, separate from foreground `ticketMiner.ts`, with a hardware-based
pool size up to eight workers. Separation avoids sharing the opening queue but does not remove CPU,
memory or main-thread-fallback contention. Latency varies with the device and number of uncached
tickets; `reopenCache.ts` keeps up to 5,000 viewed-profile packs in localStorage, subject to eviction,
quota and local cache integrity.

Opening attempts to record ticket metadata immediately in `history.ts`; quota recovery strips cached
cards from older records but keeps every record, and a mapping it still refuses is retried once its
pack is stored (`recordMissing`, below). Profile construction uses retained history for the current
key's nonce range. A ticket without a recorded set assignment stays unknown rather than guessed, and
a profile link or profile card needs every one, so a key with such a ticket can share neither. That
covers tickets opened before this device kept a history, unless the old notable-pulls log (carried
over once) held them, and any whose mapping was never recorded. The profile page says so and its
totals count only the known packs; only a backup holding the records brings the link back (#87).
If cards are missing, signing waits for reconstruction rather than completing instantly.

Own-pack reconstruction runs independently of the profile screen, batches up to 25 results into
`packStore.ts`, and uses a localStorage pending flag to attempt resumption after a reload. The
IndexedDB card-code cache is no longer loaded before rendering: after mount, `watchMyPacks`
(`profiles.ts`, via `usePackCache`) reads the current player's packs in pages of 64, one page in
flight, and aborts on unmount or when another tab changes the save; a read whose player changed is
dropped. Then it reads the rest of the history's saved packs (other players on this device), which
only history achievements wait on: your level and stats never depend on another player's packs.
Until a read succeeds, level, stats and rewards show a loading or failed note, never zero, and
locked card backs and foils fall back to the defaults without changing the saved choice; a later
failed read keeps what was shown, and a resumed re-open waits for a successful read. Achievements
earned from the history and from card modifiers are worked out only once every history pack's
cards are in, so each is credited to the pack and date that earned it; if only other players'
packs fail to read, those count by hand and score alone rather than holding back your own. A tab
whose save another tab replaced (a player switch or move, any file import, even of the same player, or
clearing this site's storage) neither unlocks achievements nor stores any progress (collection,
stats, Hall of Fame, achievements, settings): every write compares the stored player, whether its
record is still stored, and `brainrot-save-stamp-v1` with what the tab loaded, and the banner asks
for a reload. Once the tab knows, it opens no new pack (one torn open in the moment before goes back
sealed, with no ticket spent); one opened before then waits on the pending shelf under the player it
opened as (if the shelf takes it, as below), and other players' packs stay there when this one's
change. Two tabs of the same player (no import or switch, so the stamp can't tell) are guarded too:
every write also compares the stored collection, stats, Hall of Fame and achievements with what the
tab last read or stored (`src/game/progressGuard.ts`, plus a storage listener), and a tab another tab
has written past stops the same way instead of storing its older copy over that tab's packs. Packs it
took off the pending shelf at load and hasn't stored or shelved since go back on it for the next load
to add. Packs it opened itself aren't put back: any the shelf took when they opened are still there
unless the other tab has taken and stored them, so putting them back could add them twice. If storage
refuses the put-back, the save warning stays up and the next change or storage event tries again.
Settings stay last-writer-wins.
Ticket numbers (`src/game/player.ts` `claimNonce`) are claimed under a Web Lock named for the
player's public key and the number, so two tabs don't spend one number even when one tab's storage
read lags. A tab holds the lock of the highest number it took per key until it closes and lets the
lower ones go; a claim skips any number at or below a lock another tab holds. Claims for a key take
turns under a lock named for the key, and a number's lock outlasts a turn only if that claim took it,
so skipping a held number never leaves one unused (a gap in the history would break profile proofs).
A number can still go unused if a tab closes between its claim and its mapping write, or storage
refuses that write. After the claim's number lock is granted it re-reads the stored count, not
`query()`: a tab of a build from before the key lock (which claimed without it) could take the next
number meanwhile, and skipping to that would leave a gap; such a tab can rarely spend the same number
instead, which a profile resolves by the first-opened pack. Without `query()` the number locks alone
turn a claim away only from the number each tab still holds, so a lagging tab could take a lower number
another tab took and let go. Where Web Locks are missing or refuse (insecure pages, older browsers), or
the key's lock isn't granted within 5 seconds (a hung tab), a tab counts on its own, past any number it
saw taken. A count with no safe successor (past `Number.MAX_SAFE_INTEGER`) is refused before anything
is written, and history entries that high don't raise it.
A tab never hands out a number below its own count for the same key (exports carry that count too)
or at or below one its pack history maps for that key (a mapping stored while the count was refused),
rewrites the stored count while the app watches the player (`watchPlayer`) when another tab's lower
one lands later, and shows the save warning when storage refuses the new count or that rewrite
(after a reload that number could be handed out again).
Limits: progress writes have no lock across tabs, so two tabs of one player writing in the same instant can
both pass that check (the later write replaces the earlier, whose pack stays in the history; the
earlier tab then hears the write and stops), and a tab that writes before an import's stamp reaches
it can still overwrite an imported field (import with other tabs closed; the file and
`brainrot-before-import-v1` remain). A tab stopped
by an import that then failed and was undone stays stopped until it reloads. Storage cleared with no
storage event (a browser's clear-site-data) is noticed at the next write, but a pack opened first
stores this tab's player again, and if that save had no stamp the tab then writes its progress back. IndexedDB
errors can leave only memory results; writes resolve without a durable-success signal, and the pending flag
is cleared before the final save completes. Resumption and cache retention are best effort (#87).
The cache stores reconstructed cards, not a server account or a backup of all history provenance.

Collection, stats and achievements normally receive a pack when its reveal finishes, skips or the
opener unmounts. The pending shelf, `brainrot-pending-packs-v2`, supports unfinished-reveal recovery
on the next load, but writes can fail. It is always a list (up to 50, other players' packs included,
and none of theirs is dropped to make room), so an owed pack is never
replaced by a newer one. Other players' packs don't expire either: one can be the only copy of a pack
owed to that player's collection, which this browser can't check, and they come only from a tab that
opened a pack before it knew another tab had changed the save; past the cap (or if storage refuses the write), the new pack shows the save
warning and isn't on the shelf while it reveals: it still reaches the collection when its reveal
finishes in this tab (or, if that collection write is blocked, the shelf then, as below), but nothing
keeps it for the next load: a tab closed before that leaves it only in the history, if that write went
through. Load
takes every listed pack off the shelf before adding any (if the shelf can't be emptied, it adds none,
so none is added twice) and holds them until a collection holding them is stored. Taking packs off
rewrites the shelf in place; if storage refuses, it removes the shelf and writes it again, then
keeps only other players' packs (this player's other owed packs drop; the history has them), then puts
the shelf back as it was: load then adds none and leaves them listed, while a pack taken off after its
reveal stays listed and the next load may add it again (an error is logged). If even that is refused,
the shelf is gone and this tab holds other players' packs, writing them back with its next shelf
write; they are lost only if it closes first (an error is logged). If that collection
write is blocked, they stay owed by this tab and go into its next collection write; a copy also goes
back on the shelf for the next load, if the shelf takes it. A tab closed before that write leaves the
shelf copy for the next load or, if the shelf refused it, the pack only in the history. After each
collection write for owed packs, any ticket mapping the history couldn't take when they opened is
recorded (`recordMissing`; the save warning shows if it still can't be). A pack is marked as counted
(`d: 1`) before the stats counting it are written, and unmarked again if they can't be, so the next
load counts it once (entries without the mark count once). If the marked copy fits but the stats and
then the unmarked copy are both refused, the shelf keeps the marked copy, and the next load adds that
pack without counting it unless this tab stores it first.
`brainrot-pending-pack-v1` is the one-pack entry older builds keep. This build never puts a list or
a new or listed pack there, so an older build (another tab or a rollback) never finds a list to
discard, and never sees or clears listed packs. It adds the pack in that entry on load but leaves the
entry in place until a stored collection holds that pack, so an older tab that stores and clears it
still reaches the only copy; if storage won't remove the entry then, it is blanked to `null`, which
every build reads as no pack. If the collection write is blocked, the pack goes back into that entry
(marked) only while the entry still holds it; otherwise the tab that took or stored it has it. It is
never copied into the list, which an older tab's clear can't reach. A pack in both forms is added
once, and counts as counted if either copy is marked. An entry with nothing to add (unreadable, or
another player's) is removed on load, as older builds do. Accepted risk: an older tab still writes
each pack it opens into that entry, so it can replace a pack owed there, which then stays only in
the history.
Multi-key state updates are not a transaction, so this is not a guarantee against lost or duplicate
awards (#233). Screens pass whole pulled-card objects with holo/finish/misprint data
(`src/game/versions.ts`); preserving those fields still requires checks at rendering, persistence
and sharing boundaries.

### Progression

Current progression is derived from packs (`src/game/progression.ts`) and does not change the
versioned generation rules. Its claims can be recomputed for the range in a verified profile:

- **Levels** unlock a title (shown next to the level), card backs and pack foils (cosmetic, picked
  under Profile → Level rewards; applied as `data-card-back` / `data-pack-foil` on `<html>`).
- **Collection score**: the points of every card pulled, holos at holo points, with named milestones
  (Bronze 1,000 up to Brainrot 2,000,000).
- **Sets**: each set is *Complete* with every card and *Master* with every card as a holo, shown on
  the set picker and profiles, with an achievement for each.
- **Profile card** (`src/game/playerCard.ts`): a 9:16 image of all this plus the best pull, with a QR
  code for the profile link.

### Card modifiers

Besides rarity and holo, cards in a set version with `"modifiers": 1` roll a **finish** (Silver 10%,
Gold 2.5%, Platinum 0.5%, Diamond 0.1%) and a **misprint** (0.5%), and every one multiplies the card's
points by about 1 / its chance (x10, x40, x200, x1000, x200), stacking with holo (spec section 5.4).
They're derived from the ticket like everything else, so they're as checkable as the cards. Only set
versions with `modifiers: 1` roll them, preserving earlier versions without that flag. Several
older sets added modifiers in version 2; newer sets can already have them at version 1. The flag,
not the set version number alone, selects the modifier table; new packs use the latest version of
openable sets in the registry. Finishes recolour the card's printed frame (silver gray, gold yellow,
platinum blue, diamond blue/violet), with glow on platinum and diamond; misprints show off-register colours
(`src/game/modifiers.ts`), in the collection, history, Hall of Fame and the share poster, and they're
stored compactly in the pack history (`src/game/cardCode.ts`: `sigma*G!` is a holo Gold misprint).

`src/game/frameRecolor.ts` uses the shared frame's alpha mask to protect the meme artwork. Large
card views and the PNG exporter use `src/game/finishImage.ts`, caching full-size results per card/finish
in a 16-entry LRU. Each view holds its render while mounted; an evicted render's blob URL is revoked
only after its last holder lets go, so no mounted `<img>` loses its source.
Collection tiles load pre-rendered 344px WebP finishes directly, with native lazy loading and no
canvas recolouring or PNG encoding on first load. They use the same recolouring function before
resizing. `npm run cards` rebuilds these thumbnails and the small lossless mask
(`src/assets/images/card-frame-mask.webp`); `npm run cards:finish-thumbs` refreshes just the thumbnails.
Input hashes include the source image, mask, recolouring code and output settings, so changed cards
or finishes regenerate their thumbnails while unchanged assets are skipped.

## Compatibility rules and current checks

1. **Released generation inputs never change.** Card ids, order, rarities, odds, modifiers or pack
   size of a released `set@version` can't change; bump `version` and keep the old file
   (`npm run check:sets`). Display names, captions and art are outside this generation lock.
2. **Deterministic changes preserve historical results.** Version the affected set, modifier table,
   ticket, proof or rules contract as specified in `spec/PULL_SPEC.md` section 12. The engine and
   independent Python verifier must both pass every historical vector (`src/engine/spec.test.ts`
   and the `independent-verifier` CI job).
3. **Every registered card needs a built image.** `npm run cards` generates it, `check:sets`
   checks its file exists, and `check:card-assets` decodes every registered card WebP and checks
   pack wrappers, finish thumbnails, the frame mask and card back (docs/DEVELOPMENT.md). Preview
   outputs and built hosting paths are outside it.

`npm run check` runs lint, types, all tests, set locks and card assets; `npm run build` packages the
site and static previews. On every pull request and non-main push, CI runs both, the independent
verifier (`python -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json`), the
browser smoke and actionlint; deploys from main rerun the verifier and `npm run check`. These checks
do not establish real-device performance, live service availability or complete UI/persistence
coverage.

## Local agent task audits (optional, local only)

`npm run audit:agent -- --task=opening --seconds=90` (tasks: `opening`, `sharing`, `results`,
`recovery`; 30 to 180 seconds each, at most four, run one after another) lets a local Codex CLI
0.159.2 agent try a newcomer task. It needs Unix, Node 22, a git checkout, that CLI signed in or
given its API key, and Playwright's Chromium; any other CLI version fails closed. It is not part of
`npm run check` or Actions, which need no agent account; `tests/browser/agent-audit.spec.ts` checks
only the browser boundary, with no agent.

The runner refuses uncommitted tracked changes and untracked files under `src/` or `public/` (Vite
would bundle them, such as a draft set's art), builds that revision and owns a strict-port preview
at 127.0.0.1:4197. The build keeps the full environment, but the CLI gets only an allowlist
(`agentEnvironment` in `contracts.ts`): path, home, user, shell, terminal, temp directory, time zone
and locale; proxy and CA-certificate settings; and its own Codex home and key and OpenAI key, base
URL, organization and project variables. CI, GitHub and other tokens never reach it, and the browser
endpoint reaches the MCP adapter through the CLI's config, not its environment. Each task gets a
fresh disposable identity and a restricted MCP adapter (`scripts/agent-audit/`): accessibility
snapshots, clicks on the one button or link with an exact, non-empty accessible name (no match or
several matches is refused, not guessed) and navigation keys, at most 40 calls even when they
overlap, with no evaluation, URLs, files or saves. The browser blocks external requests,
WebSockets, POSTs, service workers, clipboard, native share, downloads and export, import, share and
submit controls, so sharing tasks may stop at that boundary. It writes a sanitized
`test-results/agent-audit.json` and never posts, merges or deploys. Agent outcomes are not human
evidence. No real agent task run has been recorded yet (unrun). Refs #239.

## Proposals (not shipped)

These await the owner's decision and describe nothing the app does today.

### Display-name and publication policy (#348)

Status: proposed, awaiting owner (#348).

No matcher or enforcement is installed. Names are nonunique labels beside a key fingerprint (spec
section 9). Retain released 24-code-point/fixed-character proof rules (spec section 7, rule 2); verify
the original signed bytes, never a normalized substitute. Legacy empty names remain valid (viewers
show "Anonymous"). Format, cryptographic validity and permitted publication are separate; React
escaping and the bot's Markdown sanitiser are not moderation. Today the name field already counts
code points (it cuts input at 24, silently) and a rename to a blank name is refused; entry UI should
also preview normalization and explain rejected or truncated input. A grapheme or UTF-16
`maxLength` is not that count.

| Owner decision | Recommendation for review |
| --- | --- |
| Languages/content | Explicit English scope; disallow targeted slurs/harassment, explicit sexual names, spam/links and false official affiliation |
| Ordinary slang/swearing | Allow meme slang; owner sets swearing threshold before selecting a preset |
| Disallowed name in valid existing proof | Keep verification; show “Name hidden” plus fingerprint, with separate policy explanation |
| New public submission | Reject publication with actionable feedback; retain original signed evidence |
| Appeals/overrides/removal | Owner chooses contact/process; versioned allowlist and review; rejected-issue removal/rebuild |

Apply one policy version at editable UI and trusted issue/relay intake, including bypassed clients.
Mask pending/direct pull/profile views, captions/posters and accessible text consistently; private
backups preserve raw signed evidence. Old external images cannot be recalled. A matcher cannot
reliably identify impersonation or establish human identity; retain key fingerprints without that claim.

Official READMEs reviewed October 15, 2026: [Obscenity](https://github.com/jo3-l/obscenity) offers an
English preset, configurable transformations/boundaries and whitelist (MIT); [@2toad/profanity](https://github.com/2Toad/Profanity)
offers multiple languages, whole-word and Unicode-boundary options (default boundaries are ASCII-
oriented). Both need explicit false-positive exceptions. A small audited matcher avoids a package
but makes evasions/boundaries our maintenance responsibility. Evaluate Obscenity first for an
English policy, without adopting its preset wholesale. Before selection, inspect pinned dependency/
license data and measure compressed client bytes and short-name cost; benchmarks remain **unrun**.

Planned fixtures include 24/25 code points, astral emoji, combining sequences, empty/space/control/
bidi input, links, mixed-script/leet evasions, and legitimate substrings such as Scunthorpe/Arsenic.
Expected moderation outcomes require the approved policy; these are not library pass claims. Bound
input work; retain existing proof-decoder limits. Full boundary/removal fixtures stay in #348/#21;
after approval split entry feedback, shared matcher and trusted publication/display implementation.
No signed name bytes, released proof rules or generator versions change in this proposal.

### Scalable-profile decision (#323)

Status: proposed, awaiting owner (#323).

**For review: defer production aggregate formats; proceed with one bounded feasibility prototype.**
A minimal input ledger is interim provenance protection, not the owner's final history-free design.
Current profile v1 signs assignments for tickets 0..N−1 as runs, XP and up to five best-pack claims
(min(5, N)). The bounds below (N ≤ 100,000, at most 64 set entries) come from
`src/engine/profile.ts` (spec section 11). Today `history.ts` already keeps every recorded assignment
as JSON in localStorage (`brainrot-history-v1`): quota recovery drops only cached cards, and an
unrecorded assignment stays unknown and blocks the profile link (see Profiles and levels).

| Route | State / verification | Decision boundary |
| --- | --- | --- |
| Minimal original-assignment ledger | O(N) worst-case assignments and cold regeneration; cards/images are caches | Near-term storage mitigation (a compact form of today's history), not scalable aggregate verification |
| Recursive aggregate proof / IVC | Updatable proof/prover state plus current aggregates; succinct verification can avoid historical replay | Candidate long-term route; Argon2id proving/browser feasibility unmeasured |
| Trusted verified checkpoint | Bounded job replays a range and signs aggregate state | Optional trusted service (#243), even if built on Actions/Workers |

Six bits per assignment at 64 set entries gives 75,000 raw bytes for 100,000 tickets, excluding
identity/table/encoding/database overhead; runs compress long sessions. This arithmetic bound is
not a measured save size. Public v1 remains run-based with worst-case long links. IndexedDB can
exceed localStorage's common roughly 5MiB limit but still faces quota, denial, eviction and clearing.
A migration keeps today's rule: known assignments or valid same-key profile runs only; missing
history stays unknown, never guessed. Save-schema changes do not require changed generator odds; a new public
proof format requires separate version/spec/vectors and an independent verifier.

An IVC step must bind initial identity, monotonic nonce, original allowed rules and every aggregate
update. Collection/variant state and prover parameters need not be constant-sized. Bootstrap from
intact inputs; lost assignments cannot be retroactively certified. A compact verification proof may
omit state needed to continue proving after restore. [Nova](https://github.com/microsoft/Nova)
establishes IVC/compression primitives, not practical browser proving for 32MiB/two-iteration Argon2id;
parameter/setup trust needs separate review. Checkpoints instead require named verifier key/rules,
range commitment, budgets, availability, rollback/key-rotation and owner acceptance of service trust.

Next prototype stays outside production builds/formats: one exact released derivation/aggregate
step in one selected circuit/zkVM, engine fixture equality and altered-input rejection. Measure
prover time/peak memory, parameters/download bytes, proof versus resumable-state bytes, verification,
browser/WASM feasibility and export/restore/continue; all benchmarks are **unrun**. Compare bounded
checkpoint replay budgets without deployment, then choose proceed/defer. Full acceptance stays in
#323. Neither route witnesses human play, animation completion, wall-clock time or undeclared lifetime
mining; self-signed totals/Merkle roots alone do not prove aggregate correctness.
