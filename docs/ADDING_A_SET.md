# Adding a set

A set is data: a `set.json` plus art. No code changes are needed apart from one import line.

## 1. Pick the cards

12 cards is a good size: 4 Common, 3 Uncommon, 2 Rare, 1 Epic, 1 Legendary, 1 Brainrot. The
rarest slot goes to the most iconic or funniest meme of the era.

Rules (see "Real images only" in `docs/ART_STYLE.md`):
- **Every card is a real meme with its real name and real image.** No parodies or lookalikes.
- **Skip memes you can't show for real:** the owner enforces takedowns, the only images centre on a
  private individual or a minor, or it's NSFW, gore or hate-associated. Pick another meme from the era.
- Public figures in their meme moment, animals, objects, and film, TV, game or AI-character stills are fine.

## 2. Write `src/content/sets/<set-id>/set.json`

```json
{
  "id": "my-set",
  "version": 1,
  "name": "My Set",
  "era": "2027",
  "tagline": "Fresh off the timeline",
  "releasedAt": "2027-01-01",
  "draft": true,
  "palette": ["#FFD60A", "#00B4D8", "#FF4D6D"],
  "packSize": 5,
  "odds": { "COMMON": 5000, "UNCOMMON": 2500, "RARE": 1500, "EPIC": 700, "LEGENDARY": 250, "BRAINROT": 50 },
  "holoOdds": 500,
  "modifiers": 1,
  "cards": [
    {
      "id": "kebab-case-id",
      "name": "Display Name",
      "rarity": "COMMON",
      "caption": "Short punchline (max ~26 chars)",
      "flavor": "One line of origin story",
      "year": 2027,
      "art": "What the illustration shows"
    }
  ]
}
```

- Odds are integer weights out of 10,000; `holoOdds` is also out of 10,000.
- `"modifiers": 1` gives every card a chance at a finish (Silver, Gold, Platinum, Diamond) and a
  misprint, on top of holo (spec section 5.4). New sets should have it. It's part of the set's
  version: adding it to a released set means a new version, like any change to odds.
- `draft: true` hides the set unless a player turns on **Sound & display → Preview upcoming sets**.
  Remove it when the art is final.

## 3. Get the real images

Save each meme's real image as `art/<card-id>.png` and record its source in `CREDITS.md` (see "Real
images only" in `docs/ART_STYLE.md`). If a meme can't use its real image, swap the card for another meme
from the same era. Preview the whole set:

```bash
npx tsx scripts/cards/preview.ts my-set /tmp/my-set.png
```

## 4. Register, build and lock

1. Add the import to `src/content/sets/index.ts` and put it in `ALL_SET_VERSIONS` (array order is
   timeline order).
2. Run:
   ```bash
   npm run cards
   npm run check:sets -- --update   # locks my-set@1
   npm run check
   ```
3. Commit `set.json`, `art/`, `cards/`, `pack.webp`, `pack-thumb.webp`, `CREDITS.md` and `sets.lock.json`, then
   open a PR.
4. Optionally run `npm run og-image` so link previews show the newest sets.

## Archiving a set

If a set can't stay on sale (say a rights holder starts enforcing), add `"archivedAt": "YYYY-MM-DD"`
to its `set.json`. Nobody can open new packs from it, and its cards stop counting toward completion
achievements. It stays in the registry, so every old pull link and Hall of Fame entry still verifies,
and players keep the cards they own (marked Archived in their collection). Genesis is archived this way.

## Changing a released set

Fixing names, captions, flavor or art is fine at any time. Changing **cards, their order, rarities,
odds or pack size** breaks every proof for that version, so:

1. Copy `set.json` to `set.v1.json` and import it in the registry as well.
2. Bump `version` in `set.json` and make the change.
3. Run `npm run cards` and `npm run check:sets -- --update`. The lock gains the new version's key;
   every existing key and hash must stay as it was, which `npm run check:history` checks against
   main (docs/ARCHITECTURE.md, Compatibility rules).
