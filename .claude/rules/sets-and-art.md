---
paths:
  - "src/content/**"
  - "scripts/cards/**"
  - "scripts/check-sets.ts"
---

# Sets and card art

- New or changed sets follow docs/ADDING_A_SET.md; /new-set drafts a whole set.
- `cards/`, `finish-thumbs/` and `pack*.webp` are built by `npm run cards`. Don't edit them by hand.
- Check art with one contact sheet (`npx tsx scripts/cards/preview.ts <set-id> <out.png>`), not
  card by card: every image you view costs one to two thousand tokens.
- `npm run check:sets -- --update` only locks new set versions; it refuses changes to released ones.
- CREDITS.md files run to 10-18 KB. Append to them; don't read them whole.
