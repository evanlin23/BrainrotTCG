# Open Card Database & Fan-Tool API

Brainrot TCG publishes static, canonical JSON catalogs at build time so fan tools, community wikis, Discord bots, and pack simulators can build on verified game data without web scraping or server authentication.

All endpoints are static files served over HTTPS with open CORS.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/sets.json` | All current sets and historical set versions, exact rarity odds, pack sizes, and deterministic card lists |
| `GET /api/cards.json` | Complete card database: card keys, names, rarities, base points, image assets, captions, and flavor text |
| `GET /api/hall-of-fame.json` | Top verified Hall of Fame pulls (also served at `/hall-of-fame.json`) |

Production base address: `https://brainrottcg.pages.dev/`  
GitHub Pages mirror: `https://evanlin23.github.io/BrainrotTCG/`

---

## 1. Sets API (`/api/sets.json`)

Returns canonical metadata for every openable and released set, plus `allVersions` for pull verifiers.

### Schema

```json
{
  "version": 1,
  "totalSets": 10,
  "sets": [
    {
      "id": "right-now",
      "name": "Right Now",
      "version": 2,
      "era": "October 2026",
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
      "palette": ["#ff3df2", "#29f0ff"],
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
      "image": "assets/cards/genesis/locked-in-alien.webp",
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

---

## 3. Hall of Fame API (`/api/hall-of-fame.json`)

Returns an array of verified community pull records published by the Hall of Fame intake pipeline. Each entry includes the player's display name, public key fingerprint, Ed25519-signed proof, hand name, and score.
