---
name: new-set
description: Research current meme trends and draft a new Brainrot TCG card set end to end (card list, set.json, real meme images with credits, previews), ready for a draft PR. Use when asked to add, draft or update a card set, era, or monthly drop.
---

# Drafting a new Brainrot TCG set

Read `docs/ADDING_A_SET.md` and `docs/ART_STYLE.md` first; they are the source of truth.

## 1. Research (use subagents with web search)

- Follow `docs/TREND_SCOUT.md`: which sources work (Know Your Meme RSS, Instagram Explore, trends24,
  Wikipedia pageviews, Google Trends RSS, trend blogs), what counts as a real trend (two independent
  publishers in 21 days plus a platform signal), and the scraping rules (no logins, honour robots.txt).
  Don't try to scroll TikTok or Reels directly.
- Read the latest comments on the **Trend scout** issue: weekly findings plus links people posted.
- Look beyond the US (Indonesia, Brazil, India, Korea, Spain/LatAm, Philippines...). Cite sources with
  dates.
- Check open GitHub issues titled "Propose a card" (community proposals); top-voted ones go first.
- Skip memes already in an existing set (`grep -h '"name"' src/content/sets/*/set.json`).

## 2. Card list

12 cards: 4 COMMON, 3 UNCOMMON, 2 RARE, 1 EPIC, 1 LEGENDARY, 1 BRAINROT. Names max 22 chars,
captions max ~26 chars and genuinely funny, flavor max 90 chars, plus an `art` brief.

Hard rules: every card is the real meme with its real name. Skip any meme whose owner enforces
takedowns, whose only images centre on a private individual or a minor, or that is NSFW, gore or
hate-associated, and pick another from the same era. PG-13. Flag anything risky in the PR description.

## 3. Files

1. `src/content/sets/<id>/set.json` with `"draft": true` (template in `docs/ADDING_A_SET.md`). A monthly
   drop is a new set with id `drop-YYYY-MM` and a permanent name for its window and theme (e.g. "Summer of
   Slop"); never a relative name like "Right Now", which goes stale. The app marks the newest set "New".
2. Real images: for every card, the meme's canonical image from the web saved as
   `src/content/sets/<id>/art/<card-id>.png`, following "Real images only" in `docs/ART_STYLE.md`
   (download into an empty folder, validate and re-encode with `python3 -I` + Pillow, crop to 6:7).
   If a meme can't use its real image, replace the card with another meme from the same era. No
   placeholders or lookalikes. Record every source in `CREDITS.md`. Delegate one subagent per set and
   have it review its own contact sheet: `npx tsx scripts/cards/preview.ts <id> /tmp/<id>.png`.
3. Make sure the rarest slots hold the most iconic memes.
4. Register the set in `src/content/sets/index.ts`, then run `npm run cards`,
   `npm run check:sets -- --update` and `npm run check`.

## 4. Pull request

Open a **draft** PR with the contact sheet image, the research summary with sources, `CREDITS.md`,
and notes on any replaced cards. A human approves tone, IP and art before removing `"draft": true`.
