# Design

How Brainrot TCG looks and behaves. The values live in `src/styles/tokens.css`; the shared pieces in
`src/styles/base.css` and `src/components/ui/`. Most players are on phones, opening packs one-handed
between other things, so every rule below starts from a 390 px wide screen.

## Principles

1. **The pack is the hero.** Each screen has one primary action: on the home screen it's opening the
   pack; during a reveal it's the next card; in the summary it's opening another pack. Everything else
   steps back (smaller, quieter, or out of the way).
2. **Nothing overlaps the game.** Navigation is a bottom tab bar on phones (in the thumb zone) and a top
   bar on wide screens, laid out around the content rather than floating over it.
3. **Focus mode while opening.** Once a pack is cut, the tabs and the era picker get out of the way
   until the pack is done, so the reveal owns the screen.
4. **One way to show a panel.** Collection, achievements, settings, sharing and the rest are the same
   sheet: a bottom sheet on phones, a centred dialog on wide screens, with the same header, close
   button, Escape key, focus handling and backdrop.
5. **Readable before flashy.** Rubik Glitch is for the logo only. Headings and big numbers use Lilita
   One; everything else is Archivo, whose condensed widths set labels like a grading slab. Numbers are tabular.
6. **Colour carries meaning.** Surfaces are a binder-black ramp with card-stock white text. There is
   one accent, price-sticker yellow, and it only marks the thing to do next (primary buttons,
   progress, the "New" set). Foil only ever appears on holo cards. Rarity colours are identical
   everywhere and always come with their symbol (● ◆ ★ ★★ ★★★ ✦), so colour is never the only cue.
7. **Celebrate in proportion.** A common card gets a flip; a Brainrot pull gets the confetti.
   Achievement toasts arrive one at a time, small and out of the way; a burst of unlocks becomes one
   grouped toast instead of a wall.
8. **Speak the device's language.** Phones say "Tap", desktops say "Click or press Space". Hints that
   only make sense with a mouse (tilt the card) only show with a mouse.
9. **Accessible by default.** Text meets WCAG AA contrast; every control is reachable by keyboard with a
   visible focus ring; touch targets are at least 44 px; panels trap focus and close with Escape;
   motion is reduced when the OS asks for it.
10. **Fast and steady.** Images have fixed aspect ratios so nothing jumps while loading; animations are
    120–320 ms and only animate transform and opacity.

## Looks like a card game, not like an AI demo

The look comes from collecting real cards: binder pages, sleeves, set checklists, collector numbers
("SOS 007/012"), set codes printed in the set's colour, rarity marks, and graded-card labels for
anything verified. Generic app chrome gives a page away as generated. Don't use:

- gradients on buttons, text, borders or backgrounds (foil on holo cards is the one exception);
- glows, glassy blur, or tinted "neon" shadows;
- emoji as bullets or markers (🧠 before every score, ✨ for holo); emoji stay where they're content,
  like an achievement's icon or a share post;
- small letter-spaced uppercase headings over every section; headings are plain sentence case;
- coloured rails down the side of rounded cards, and pills for everything;
- a row of boxed "big number" tiles; four numbers on one line read faster;
- generic system fonts or Inter, and centring everything.

## Tokens

| Group | Tokens | Notes |
| --- | --- | --- |
| Surfaces | `--bg`, `--bg-elevated`, `--surface`, `--surface-2`, `--surface-3` | lighter = closer |
| Text | `--text`, `--text-muted`, `--text-subtle` | all AA on `--bg-elevated` |
| Accent | `--brand` (sticker yellow), `--brand-strong`, `--brand-ink` (text on yellow), `--foil` | foil is for holo cards only; `--brand-gradient` is kept as an alias of the flat accent |
| Rarity | `--rarity-common` … `--rarity-brainrot` | never redefine locally |
| Type | `--font-body`, `--font-display`, `--font-logo`, `--text-xs` … `--text-3xl` | |
| Space | `--space-1` (4 px) … `--space-7` (48 px), `--gutter` | 4 px grid |
| Shape | `--radius-sm` … `--radius-xl`, `--radius-pill` | |
| Depth | `--shadow-1` … `--shadow-3` | `--glow-brand` is `none` |
| Motion | `--dur-fast`, `--dur`, `--dur-slow`, `--ease-out`, `--ease-spring` | zero under reduced motion |
| Layout | `--touch-target`, `--nav-height`, `--safe-top`, `--safe-bottom` | |

## Components

- **Buttons** (`.btn`): `.btn--primary` (flat yellow background, one per screen), `.btn--secondary`
  (surface + border), `.btn--ghost` (text only); `.btn--lg`, `.btn--sm`, `.btn--block`; `.icon-btn`
  for icon-only buttons, always with an `aria-label`.
- **Sheet** (`ui/Sheet.tsx`): every panel. A bottom sheet on phones, a centred dialog from 720px.
  Title, optional subtitle and sticky footer, close button, Escape, focus trap, scroll lock, focus
  returns to the opener. Sheets stack (a card opened from the collection sits on top of it). Sizes:
  `sm` (settings, share), `md` (one pull), `lg` (collection, history, achievements, Hall of Fame),
  `full` (shared pull); `bare` for a single big card.
- **Tabs** (`ui/Tabs.tsx`): text with a yellow underline, like binder dividers, when one sheet holds
  several lists, so only one shows at a time. Arrow keys move between tabs.
- **Set code** (`.set-code`, `setCode()`): a set's initials in its colour, next to its name in rows.
- **Verified label** (`.pull-viewer-badge`): a bordered, condensed caps strip with a cert number
  (player ID and ticket), like the label on a graded card.
- **Rows**: lists are rows (thumbnail, two lines of text, a value on the right, a chevron when it
  opens something), not cards in a grid. Settings use grouped rows with `.switch` toggles.
- **App nav** (`ui/AppNav.tsx`): Collection, Profile, Hall of Fame, Achievements, Settings, each an
  icon plus a label.
- **Toasts** (`achievements/AchievementToasts.tsx`): top centre on mobile, top right under nav on desktop, auto-dismiss.
- **Chips and badges**: era chips in the picker; rarity badges show name, colour and points.
- **Empty states**: one icon, one sentence that says what to do next.

## Checking a change

Run the app, then capture every screen at 390×844 and 1440×900 (a Playwright script that opens a
pack and every sheet is the quickest way). Look for overlap, cut-off text and anything that needs a
mouse. Keyboard through it: Tab reaches everything, Escape closes the top panel.
