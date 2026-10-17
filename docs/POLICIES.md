# Policies

Owner decisions of 2026-10-17 on money, privacy and kids, and content. This is a project policy,
not legal advice, and it does not claim compliance with any law. The data audit describes what the
code does today (paths in brackets); change this file in the same PR as any change it describes.

## Monetization (#76)

- Packs are free forever. Tickets come from computing time (Argon2id proof of work), never payment.
- No paid random items, ever: no loot boxes, paid packs, paid rerolls or paid chances at a rarer
  card, in any set, whatever the odds shown.
- If money is ever needed, only non-random things: donations, cosmetics sold as exactly what the
  buyer sees, or merch. Nothing sold changes pack odds, rarity, tickets or Hall of Fame standing.
- Today the game has no payment code, ads or analytics, and takes no money.

Why the line is firm: regulators treat paid randomised items differently from country to country,
and the rules keep changing.

- Belgium: its Gaming Commission concluded in 2018 that loot boxes bought with real money are
  gambling, with prosecution risk for publishers
  ([Verdict, 10 May 2018](https://www.verdict.co.uk/belgium-loot-box-ban/)).
- Netherlands: the Kansspelautoriteit fined Electronic Arts over FIFA packs in 2019, and the Council
  of State overturned that in March 2022 because the packs were not a standalone game of chance and
  their contents could not be turned into money
  ([SBC News](https://sbcnews.co.uk/europe/uk/2022/03/10/ea-wins-long-standing-loot-box-drama-against-dutch-ksa/),
  [Council of State case page](https://www.raadvanstate.nl/uitspraken/@130150/202005769-1-a3/);
  the reasoning is from press summaries, the judgment text was not reviewed).

Get legal advice before selling anything with a random outcome. A free pack does not need it.

## Privacy and kids (#75)

### What stays in the browser

Saves (collection, history, stats, settings, reopen state) live in `localStorage` and IndexedDB under
`brainrot-*-v1` keys [`src/game/*`, `src/utils/storage.ts`]. The player record
(`brainrot-player-v1`) holds the secret signing key and display name; a new player gets a random
name like "Adjective Noun 42" [`src/game/player.ts`]. Nothing is uploaded automatically. Settings'
save export contains the secret key and must stay private. Clearing site data deletes the key, so
earlier pulls can no longer be signed on that device. When the site moves address, a save passes
between the two addresses window to window, never in a URL [`src/game/move.ts`].

### What becomes public or reaches other services

| When | What | Where it goes |
|---|---|---|
| Player copies or shares a pull or profile link | The whole proof after `#`: display name, public key, signature, pack inputs. The poster image also shows the name. | To whoever receives it. A `#` fragment is not sent in page requests, so the host sees only the generic preview path for the hand [ARCHITECTURE: Sharing and link previews]. |
| Player taps Submit on the share sheet | A Nostr event holding the proof (name, public key), signed by a throwaway key | Five public relays: relay.damus.io, nos.lol, relay.primal.net, offchain.pub, relay.nostr.net [`src/game/nostrInbox.ts`]. A GitHub Action then files a public issue as a bot and the pull enters `public/hall-of-fame.json` with name, fingerprint, proof, cards and a `githubUser` field (`nostr` for relay submissions). |
| Someone files the Hall of Fame issue form by hand (not linked from the game) | The proof, plus their GitHub login on the issue and in `hall-of-fame.json` | GitHub; needs an account |
| Player opens a bug report on GitHub | Only what they paste. The generated report excludes keys, saves, names, proof links and raw errors. | GitHub; needs an account |
| Any visit | IP address, user agent and requested paths, as for any website | The host, Cloudflare Pages (the old GitHub Pages address redirects). Both keep logs under their own policies. |
| Visiting Rankings, or a pack summary that checks the board | A read request to the same five relays for recent pulls, with no name attached | Relay operators can see the visitor's IP address (inferred from how WebSocket connections work), even if the visitor never submits. |

Submitted pulls are effectively permanent: this project can hide an entry from the published list
(a maintainer adds the `rejected` label) but cannot recall copies held by relays, GitHub or others.
Renaming only changes future signatures; old proofs keep the name they were signed with.

The game loads no third-party scripts, fonts or images: fonts, art and audio are bundled and served
from the same origin, and the only other `fetch` is `hall-of-fame.json` from that origin
[`src/styles/tokens.css`, `src/game/hallOfFameList.ts`]. A display name is free text up to 24
characters; the code cleans control characters but has no profanity filter, and the name can be
a real name if the player types one. So "no personal data is collected" is not claimed.

### Chat and public text

There is no chat, messaging, comments, friends list or profile bio. The public text surfaces are:

- the display name: Rankings and its pending list, pull and profile viewer sheets, the share poster,
  shared links, Nostr events, Hall of Fame issues and `hall-of-fame.json`;
- the early players' names credited on Rankings, hard-coded in `HallOfFamePage.tsx`;
- text a player writes themselves in a GitHub issue (bug reports); there is no card-proposal form in
  the game.

### Parent FAQ

- **Can strangers message my child?** No. The game has no chat or messaging.
- **Does my child need an account?** No. Playing, sharing and Hall of Fame submission use no account.
- **What do we publish?** Only what is in the table above, mainly the display name and a key
  fingerprint when a pull is shared or submitted. Pick a name that is not a real name.
- **Does GitHub come into it?** Only for bug reports and the manual issue form. GitHub requires
  users to be 13 or older ([GitHub Terms of Service, B.3](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)),
  and the bug-report screens say so before the link.
- **Can they spend money?** No. Packs are free and there is nothing to buy (see Monetization).
- **How do we erase local data?** Clear this site's data in the browser. That removes the saves and
  the key but not anything already shared or submitted.
- **Who do we ask to remove an entry?** The contact route is an open owner decision (see Content).

## Content and IP (#22)

- This section is where the content and IP policy lives; there is no separate document.
- Genesis (archived 2026-10-12, so new players cannot open it) keeps its cards as they are. Archiving
  stops new packs but keeps old pulls and proofs valid [docs/ADDING_A_SET.md].
- The owner approves tone, rights and art for every new set or draft flag removal; sources for each
  set's art are recorded in its `CREDITS.md`.
- Not decided here, because they are the owner's: the licence for code and art, and the takedown
  and removal contact. Until they are set, nothing in this repository states either.
