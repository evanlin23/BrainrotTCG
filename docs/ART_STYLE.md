# Card art pipeline

Every card uses the **Genesis frame**: the neon border, winged title banner and caption box from
the original hackathon cards. `scripts/cards/extract-genesis-frame.py` recovered it from the 19
Genesis cards (they all share one frame) into `scripts/cards/templates/genesis-frame.png`, with a
transparent art window.

A card is then built from three layers:

1. **Art**: the meme's real image, cover-fitted into the art window
2. **The Genesis frame** on top
3. **Title and caption** set by code: the title curves along the banner, the caption sits in the box.
   Text comes from `set.json`, so it's always spelled right, and editing a caption never means
   regenerating art.

## Supplying art

Put files in `src/content/sets/<set>/art/`, named by card id. The first match wins:

| File | Meaning |
| --- | --- |
| `<card>.png` / `.jpg` / `.webp` | **The normal case.** The meme's real image, framed by code |
| `<card>.card.png` / `.jpg` / `.webp` | A complete card that already has its frame, used as-is (how Genesis was made) |
| `<card>.svg` | Placeholder only. Not allowed in a released set |

## Real images only

Every card shows **the real meme**: the canonical image people know (Know Your Meme's main image,
the top image search result, Wikimedia Commons, official stills), saved as `art/<card-id>.png`, with
its source recorded in the set's `CREDITS.md`.

If a meme can't use its real image, **swap the card for a different meme** from the same era (same
rarity slot) rather than drawing a lookalike. A meme can't use its real image when:
- its owner actively enforces takedowns or has sued (e.g. Nyan Cat, Trollface, Keyboard Cat, Grumpy Cat,
  Rickroll, Moo Deng, Socially Awkward Penguin);
- the only images centre on a private individual or a minor;
- it's NSFW, gore or hate-associated.

The rarest slots go to the most iconic memes in the set.

Downloaded files are untrusted: download each into its own empty folder, then validate and re-encode it
with Pillow (`python3 -I`, which also strips metadata) before it goes into `art/`.

Then run `npm run cards`. It also builds the set's booster pack wrapper (`pack.webp`) from the set's
colours, the logo mark (`src/styles/logoMark.ts`) and the card frames' loud motifs (starbursts, lightning,
skulls, stars, heavy dark outlines), so every era gets its own pack with no extra art. The wrapper is one
sealed foil pack with a single burst badge: it carries no card art and no card fan.

To preview one set (registered or not) as a contact sheet:

```bash
npx tsx scripts/cards/preview.ts <set-id> /tmp/<set-id>.png
```

## Optional: original art with the free Gemini app

Only for original content (e.g. a friend-group set), not for existing memes.

1. Open a new chat in the Gemini app and attach a Genesis card as the style reference,
   e.g. `src/content/sets/genesis/art/tralalero-tralala.card.png`.
2. Paste:
   ```
   You're the illustrator for a meme trading card game. I'll send card briefs one at a time. For each one, generate ONE image:
   - Match the rendering style of the attached card's artwork: vivid, glossy, high-detail, slightly surreal meme realism, dramatic lighting, saturated colors
   - Illustration only: NO card frame, NO border, NO text, letters, numbers or logos
   - Portrait 6:7, subject centered and fully visible, keep the edges free of important detail
   - No real or recognizable people
   Reply "ready" and wait for the first brief.
   ```
3. Send one card per message: `Card: <name> — <art brief from set.json>`.
4. Save each image as `src/content/sets/<set>/art/<card-id>.png` and run `npm run cards`.

The Gemini app's free daily image limit is enough for a set in a session or two. The Gemini
API has no free tier for images; at about $0.03 per image it's an option for bulk work.

## Image rules (all sources)

- **Shape:** portrait, about 6:7 (the art window is 444×519 px). Anything else is cover-cropped.
- **Edges:** frame decorations overlap the window's edges (a heart and star at the top, starbursts at
  the sides), so keep faces and key props away from the outer ~30 px.
- **Text:** crop out caption text the frame already supplies. Text that is part of the meme itself
  (a road sign, a map label) can stay.
- **People:** public figures in their meme moment are fine. Crop out bystanders where you can. Skip
  memes whose only images centre on a private individual or a minor. Team self-portraits (like
  Genesis's Buh67) need the person's OK.
- **Keep it PG-13:** no hate symbols, gore or sexual content.

## SVG placeholders

- Bold sticker-cartoon look: flat fills, thick `#12002a` outlines, expressive eyes, saturated colours,
  simple background covering the whole canvas.
- `viewBox="0 0 444 519"` (older 487×560 drawings also work; they get cropped slightly).
- Prefix every `id` with `art-`. No `<text>`, raster images, external references or `<style>` blocks.
  Keep each file under 15 KB.
