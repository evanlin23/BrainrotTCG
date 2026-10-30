# Open Card Database & Fan-Tool API

Brainrot TCG publishes static, canonical JSON catalogs at build time so fan tools, community wikis, Discord bots, and pack simulators can build on verified game data without web scraping or server authentication.

All endpoints are static files served over HTTPS with open CORS.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/sets.json` | All released sets and historical set versions, exact rarity odds, pack sizes, and deterministic card lists |
| `GET /api/cards.json` | Complete card database: card keys, names, rarities, base points, captions, and flavor text |
| `GET /api/hall-of-fame.json` | Top verified Hall of Fame pulls (also served at `/hall-of-fame.json`) |

Base address: `https://brainrottcg.pages.dev/` (the old GitHub Pages address redirects there; see
[HOSTING.md](HOSTING.md)), so for example `https://brainrottcg.pages.dev/api/sets.json`.

Draft sets (opt-in previews in the app, whose cards may still change) are left out of every
endpoint until they are released, so `draft` is always `false`.

---

## 1. Sets API (`/api/sets.json`)

Returns the latest version of every released set (archived ones too, with `archivedAt` set), plus every released version in `allVersions` for pull verifiers.

### Schema

```json
{
  "version": 1,
  "totalSets": 10,
  "sets": [
    {
      "id": "right-now",
      "name": "Summer of Slop",
      "version": 2,
      "era": "Jul–Oct 2026",
      "packSize": 5,
      "odds": {
        "COMMON": 5000,
        "UNCOMMON": 2500,
        "RARE": 1500,
        "EPIC": 700,
        "LEGENDARY": 250,
        "BRAINROT": 50
      },
      "holoOdds": 500,
      "modifiers": 1,
      "draft": false,
      "archivedAt": null,
      "palette": ["#FFD60A", "#00B4D8", "#FF4D6D"],
      "cardCount": 12,
      "cards": [
        {
          "id": "card-id",
          "name": "Card Name",
          "rarity": "COMMON",
          "caption": "Flavor or meme caption",
          "flavor": null
        }
      ]
    }
  ],
  "allVersions": [ ... ]
}
```

### Verification Invariants
- `odds` sum to exactly **10000** integer weights.
- `cards` ordering is normative: `spec/PULL_SPEC.md` requires the exact card index in `cards` for deterministically rolling pack contents from PRNG draws.
- Older versions in `allVersions` preserve immutable historical set versions for verifying older pulls.

---

## 2. Cards API (`/api/cards.json`)

Returns every card indexed by its unique `${setId}/${id}` key.

### Schema

```json
{
  "version": 1,
  "totalCards": 127,
  "cards": [
    {
      "key": "genesis/locked-in-alien",
      "setId": "genesis",
      "id": "locked-in-alien",
      "name": "Locked In Alien",
      "rarity": "COMMON",
      "points": 10,
      "caption": "Your time is limited",
      "flavor": null,
      "isOpenable": false
    }
  ]
}
```

### Card Points
Standard card points match the engine's rarity assignments:
- `COMMON`: 10
- `UNCOMMON`: 20
- `RARE`: 35
- `EPIC`: 70
- `LEGENDARY`: 200
- `BRAINROT`: 1,000

(Holo cards multiply card points by 20×).

### No image addresses
Cards carry no `image` field. The site serves card art only under content-hashed names
(`assets/<name>-<hash>.webp`) that change whenever the art or the build changes, so no stable
address exists to publish, and a guessed `assets/cards/<set>/<id>.webp` would be a dead link. The
build check (`scripts/check-site.ts`) fails any build whose catalogs name an `assets/` file the build
doesn't have.

---

## 3. Hall of Fame API (`/api/hall-of-fame.json`)

Returns an array of verified community pull records published by the Hall of Fame intake pipeline. Each entry includes the player's display name, public key fingerprint, Ed25519-signed proof, hand name, and score.
