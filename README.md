# Brainrot TCG

A meme-themed Trading Card Game pack opener built with React.

# Play live: https://evanlin23.github.io/BrainrotTCG

## Inspiration

We are professional brainrotters and so were inspired to create a trading card game for brainrot. 

## What it does

Open virtual card packs featuring internet meme characters by tearing them open! Drag across the dotted line to rip the pack, then reveal 5 cards one at a time. Cards come in six rarities (Common up to Brainrot) with weighted drop rates. Each reveal includes animations, sound effects, and 3D tilt interactions. Epic and Legendary pulls trigger confetti celebrations. Your collection is saved locally so you can track every card you've found.

## How we built it

- **React 19** with Vite for fast development
- **Framer Motion** for smooth card animations and transitions
- **Canvas Confetti** for celebratory effects on rare pulls
- **ElevenLabs** for generating the majority of the voice lines
- **Custom audio system** with sound effects for tearing, flipping, and reveals
- **Local Storage** for persistent collection tracking

## Challenges we ran into

The generation of the cards was the most challenging part of the project. We had to generate a large number of cards and ensure that they were unique.

## Accomplishments that we're proud of

We are proud of the pack opening experience and the commentary. 

## What we learned

I learned a lot about brainrot and using elevenlabs text to speech. I also learned a lot about image generationg using nano banana.

## What's next for BrainrotTCG

We would love to expand the card selection to include more brainrot characters and packs. Now underway: a timeline of meme eras, verifiable pulls you can show off, and a global Hall of Fame.

---

## Features

- **Timeline packs** - Each meme era is its own set, from Web Ancients (2007–2012) and Vine & Dank to Lockdown Lore, Gen Alpha Uprising, Peak Brain Rot (2024), Italian Brainrot, Six Seven Season (2025), Spring Breakdown and Summer of Slop (2026). Every card shows the real meme. The original hackathon set, Genesis, is archived: its pulls still verify
- **Verifiable pulls** - Every pack is derived from a proof-of-work ticket tied to your player key, so pulls can't be faked or edited, with no server
- **Show it off** - Share any pull as a link that anyone can verify, copy a Wordle-style brag line, or save a 9:16 poster with a QR code
- **Global Hall of Fame** - Submit a Full House or better; GitHub Actions verifies it and the page re-checks every entry on your device
- **Verifiable profiles and levels** - Share one link with every pack you've ever opened; anyone's browser re-opens them all to confirm your level, best pulls and collection
- **Interactive Pack Tearing** - Drag across the tear line to open packs with sparks and sound effects
- **Pack Opening Experience** - Cards revealed with smooth animations and confetti effects for rare pulls
- **Collection Browser** - Track your found cards with counts and rarity-colored borders
- **Rarity System** - Common, Uncommon, Rare, Epic, Legendary and Brainrot cards, plus holos
- **Brainrot Score** - Card points by rarity times combo multipliers (pairs up to 5 of a Kind); every number follows the real odds, so rarer always pays more
- **Achievements** - 70+ achievements for milestones, lucky packs and collections
- **3D Card Tilt** - Cards tilt based on mouse position for an interactive feel

## How verification works (no server)

Each pack costs one **ticket**: a memory-hard Argon2id hash of the set, your player key and a
ticket number, mined in a Web Worker while you tear the previous pack. The pack is derived from the
ticket, so a lucky pack costs exactly as much work as opening packs honestly. A share link carries a
~130-byte signed proof; whoever opens it re-derives the exact pack on their own device.

The global Hall of Fame uses GitHub Issues as the database and GitHub Actions as the verifier. Details
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Don't trust our code?** The proof format is written down in [spec/PULL_SPEC.md](spec/PULL_SPEC.md),
and [spec/verify_pull.py](spec/verify_pull.py) is a second verifier written only from that spec
(Python + OpenSSL). Check any pull yourself:

```bash
pip install cryptography
python3 spec/verify_pull.py 'https://evanlin23.github.io/BrainrotTCG/#/pull/...'
```

CI runs both verifiers against the same test vectors, including forged and malformed proofs.

## Setup

```bash
npm install
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run check` | lint, typecheck, tests and the set lock check (CI runs this) |
| `npm run cards` | build card images into `src/content/sets/<set>/cards/` |
| `npm run prompts` | write free Gemini-app prompt sheets for each set's art |
| `npm run check:sets -- --update` | lock a new set version |
| `npm run og-image` | rebuild the link preview image from the newest sets |

## Adding cards and sets

Sets are data: `src/content/sets/<set>/set.json` plus images. Every card uses the Genesis frame
(recovered from the original cards), with the image in the art window and the title and caption set
by code. See [docs/ADDING_A_SET.md](docs/ADDING_A_SET.md) and [docs/ART_STYLE.md](docs/ART_STYLE.md).

## Roadmap

The full roadmap lives in [issue #1](https://github.com/evanlin23/BrainrotTCG/issues/1).

## Tech Stack

- React 19
- Vite
- Framer Motion
- Canvas Confetti
- ElevenLabs (voice generation)
- Argon2id ([hash-wasm](https://github.com/Daninet/hash-wasm)) + Ed25519 ([noble](https://github.com/paulmillr/noble-ed25519)) for verifiable pulls
- Local Storage (collection persistence)
- GitHub Pages, Issues and Actions (hosting, Hall of Fame database and verifier)
