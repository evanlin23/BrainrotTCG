# Design

How Brainrot TCG looks and behaves. The values live in `src/styles/tokens.css`; the shared pieces in
`src/styles/base.css` and `src/components/ui/`. Each component imports the stylesheet for the classes
it renders, because a lazy screen only gets the CSS its own chunk imports (`tests/browser/lazy-styles.spec.ts`).
Most players are on phones, opening packs one-handed between other things, so every rule below starts
from a 390 px wide screen.

## Principles

1. **The pack is the hero.** Each screen has one primary action: on the home screen it's opening the
   pack; during a reveal it's the next card; in the summary it's opening another pack. Everything else
   steps back (smaller, quieter, or out of the way). A new player's home screen is only the logo, the
   gear and the pack: the tabs and the era picker come once their first pack is saved and they leave it.
   A quiet "Card guide" link under the pack (44px target, hidden from the tear until the pack is put
   away) opens the selected set's card guide, so rarity, holo and odds are a tap away before the first pull.
   The summary lists the cards best pull first (ties keep pack order), each with a quiet Share that makes
   an image of it linking to the pack; nothing is shared mid-reveal. Its actions keep their own row under
   the scrolling cards, above the phone's home indicator, and wrap their labels at large text. Under the
   revealed card, one quiet line (game, site, set and card number) says where a screenshot came from; a
   narrow phone wraps the set and number onto a second line, never cutting them off.
2. **Nothing overlaps the game.** Navigation is a bottom tab bar on phones (in the thumb zone) and a top
   bar on wide screens, laid out around the content rather than floating over it.
3. **Focus mode while opening.** Once a pack is cut, the tabs and the era picker get out of the way
   until the pack is done, so the reveal owns the screen. Every stage of a pack, from the tear to the
   summary, has the same top bar with one X ("Back to packs"), and Escape and the browser's Back do
   what it does. Tapping empty space never leaves a pack.
4. **Places are pages, moments are sheets.** Cards, Rankings, Profile and Settings are pages with an
   address (`#/cards` and so on), a title and the browser's Back; the packs screen stays mounted under
   them so a pack in progress survives. Sheets are only for things over the current place: sharing,
   a shared pull or profile, the broken-link notice and confirms. Every sheet is the same: a bottom
   sheet on phones, a centred dialog on wide screens, with the same header, close button, Escape key,
   focus handling and backdrop.
5. **Readable before flashy.** Rubik Glitch is for the logo only. Headings and big numbers use Lilita
   One; everything else is Archivo, whose condensed widths set labels like a grading slab. Numbers are tabular.
6. **Colour carries meaning.** Surfaces are a binder-black ramp with card-stock white text. There is
   one accent, price-sticker yellow, and it only marks the thing to do next (primary buttons,
   progress, the "New" set). Foil (`--foil`) only marks holo: holo cards, holo copies and the Master
   badge; the pack wrapper's foil is a separate level reward. Rarity colours are identical
   everywhere and always come with their symbol (● ◆ ★ ★★ ★★★ ✦), so colour is never the only cue.
7. **Celebrate in proportion.** A common card gets a flip; a Brainrot pull gets the confetti.
   Achievement toasts arrive one at a time, small and out of the way; a burst of unlocks becomes one
   grouped toast instead of a wall.
8. **Speak the device's language.** Phones say "Tap", desktops say "Click or press Space". Hints that
   only make sense with a mouse (tilt the card) only show with a mouse.
9. **Accessible by default.** Text meets WCAG AA contrast; every control is reachable by keyboard with a
   visible focus ring; touch targets are at least 44 px; panels trap focus and close with Escape;
   motion is reduced when the OS asks for it.
10. **Fast and steady.** Images have fixed aspect ratios so nothing jumps while loading. Card art shows a
    placeholder while it loads (a shimmer only when motion is allowed) and a hatched slot if it fails; the
    card viewer offers Retry, and failed art also retries when the device comes back online. Standard UI transitions
    are 120–320 ms (rare pull celebrations and card shimmers run longer, and specific card/reveal effects animate
    properties like box-shadow or clip-path).

## Looks like a card game, not like an AI demo

The look comes from collecting real cards: binder pages, sleeves, set checklists, collector numbers
("SOS 007/012"), set codes printed in the set's colour, rarity marks, and graded-card labels for
anything verified. Generic app chrome gives a page away as generated. Don't use:

- new gradients on app chrome (buttons, text, borders or backgrounds); cards and their finishes,
  rarity colours (the Brainrot pill), holo foil and the pack foil use them. A few older chrome
  gradients remain (the current set's colour stripe, the special-reveal rays and banner); don't
  copy them;
- glows, glassy blur, or tinted "neon" shadows on app chrome (rare card reveals and finish tells use targeted edge glows);
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
| Accent | `--brand` (sticker yellow, `#ffd23f`), `--brand-strong`, `--brand-ink` (text on yellow), `--foil`, `--foil-angle` (115deg) | one yellow: `--brand` is the price sticker, the Brainrot rarity colour and the foil's second stop, so a Brainrot pull and the app's accent read as the same thing. `--foil` marks holo only (the pack's reward foil is `--pack-foil`); `--brand-gradient` is kept as an alias of the flat accent |
| Rarity | `--rarity-common` … `--rarity-brainrot`, `--rarity-brainrot-solid`, `--rarity-brainrot-glow` | never redefine locally; `-solid` is Brainrot's one colour where a gradient can't go (borders, glows, canvas) |
| Finish | `--finish-silver` … `--finish-diamond`, `--finish-*-glow`, `--misprint*` | the finish sticker and edge-glow colours |
| Type | `--font-body`, `--font-display`, `--font-logo`, `--font-mono`, `--text-xs` … `--text-3xl` | `--font-mono` for IDs and fingerprints |
| Space | `--space-1` (4 px) … `--space-7` (48 px), `--gutter` | 4 px grid |
| Shape | `--radius-sm` (4 px), `--radius-md` (6), `--radius-lg` (10), `--radius-xl` (14), `--radius-pill` | the only radii, besides `0`, `50%` and `inherit` |
| Card | `--card-aspect` (687 / 1024, the art's own shape), `--card-tall` (its inverse) | every card face and slot uses these |
| Depth | `--shadow-1` … `--shadow-3` | `--glow-brand` is `none` |
| Motion | `--dur-fast`, `--dur`, `--dur-slow`, `--ease-out`, `--ease-spring` | zero under reduced motion |
| Layout | `--touch-target`, `--nav-height`, `--safe-top`, `--safe-bottom`, `--safe-left`, `--safe-right` | the page runs under the notch (`viewport-fit=cover`), so anything fixed to a screen edge pads by these; `theme-color` matches `--bg` |
| States | `--focus-ring`, `--focus-outline`, `--opacity-disabled` | see the rules below |
| Layers | `--z-stage-fx` (5), `--z-header` (40), `--z-nav` (50), `--z-hud` (60), `--z-sheet` (100), `--z-toast` (200) | the only z-index values above 3 |

- **Layers.** Inside a component, stack with 1-3 under `isolation: isolate` (DOM order breaks ties).
  Anything that must clear its siblings takes a `--z-*` token. `tests/style-scan.test.ts` fails on a
  raw z-index above 3.
- **Focus.** One ring for every control: `:focus-visible` draws `--focus-ring` as a box-shadow over
  the transparent `--focus-outline`, which forced colours paint instead. No control sets its own ring
  or `outline: none`; one with its own box-shadow appends `var(--focus-shadow)`, empty until focused.
- **Disabled.** `--opacity-disabled` with `cursor: not-allowed` and a dashed edge (the border, or an
  inset dashed outline on a borderless button), so colour is never the only cue.
- **Size.** `.btn--sm` keeps the 44 px `--touch-target`. Text never goes under 12 px (`--text-xs`);
  a size in `vw` or `cqw` takes a `max(0.75rem, …)` floor. New CSS has no raw colour, z-index or
  duration literals.
- **Colour.** Colour literals (hex, `rgb()`/`hsl()` and the other colour functions, named colours)
  live only in `tokens.css`. Beyond the groups above it holds small families for art and effects:
  `--tint-*` (paper and ink washes for hovers and tracks), `--shade-*` and `--scrim-strong`,
  `--chip-bg` and `--chip-bg-ink` (labels over card art), `--medal-*`, `--celebrate-*`, `--foil-*`
  stops, `--seam-*` and `--pack-gold-*` (pack art), and single effects such as `--shine`, `--sheen`,
  `--glint` and `--holo-aura`. A sheet that needs a new colour adds a token first.
  `tests/style-scan.test.ts` fails on a literal anywhere else; its allowlist names each exception and
  why (today only the tear sparks' per-spark `hsl(var(--hue) …)`).
- **Canvas.** The share images draw on a canvas, which can't read CSS variables, so
  `src/styles/palette.ts` mirrors the colours code paints with (ink, paper, brand, chip, rarity,
  finish and foil). The same test fails if it drifts from `tokens.css`; change `tokens.css` first.
- **Radius.** 4 px for stickers, badges and chips, 6 px for buttons and inputs, 10 px for card faces,
  panels and toasts, 14 px for sheets, pill for toggles and tags. `style-scan` fails
  on any other radius; the set ribbon's `1.6cqw` is the one allowlisted exception, because it is pack
  art and scales with the pack.

### Contrast

WCAG ratios for text tokens on the surfaces they sit on (AA needs 4.5:1 for body text, 3:1 for
large text and UI parts).

| Text | `--bg` | `--bg-elevated` | `--surface` | `--surface-2` | `--surface-3` |
| --- | --- | --- | --- | --- | --- |
| `--text` | 16.4 | 15.5 | 14.4 | 13.1 | 11.3 |
| `--text-muted` | 8.9 | 8.4 | 7.8 | 7.1 | 6.1 |
| `--text-subtle` | 5.3 | 5.0 | 4.7 | 4.2 | 3.7 |
| `--brand` | 13.0 | 12.4 | 11.5 | 10.4 | 9.0 |
| `--danger` | 6.8 | 6.4 | 6.0 | 5.4 | 4.7 |
| `--rarity-epic` (lowest rarity) | 7.5 | 7.1 | 6.6 | 6.0 | 5.2 |

`--brand-ink` on `--brand` is 12.8 (11.0 on `--brand-strong`). Keep `--text-subtle` for large
text or hints on `--surface` and darker; on `--surface-2` and `--surface-3` it falls under 4.5:1.

## Components

- **Buttons** (`.btn`): `.btn--primary` (flat yellow background, one per screen), `.btn--secondary`
  (surface + border), `.btn--ghost` (text only); `.btn--lg`, `.btn--sm`, `.btn--block`; `.icon-btn`
  for icon-only buttons, always with an `aria-label`.
- **Page** (`ui/Page.tsx`): Cards, Rankings, Profile and Settings. An `h1` with a "Close <title>"
  button (back to Open), then the screen, loaded on demand: a skeleton holds its place meanwhile
  (rows for Rankings, blocks otherwise), never a sheet, and a failed load offers Reload and Retry.
  Opened from inside the app, focus moves to the `h1`; the document title becomes "Cards - Brainrot
  TCG" and so on. Escape doesn't close a page; Back and Close do. Each view has one `h1`: the page's
  title on a page, the logo on Open (on a page the logo is a named image, not a heading).
- **Sheet** (`ui/Sheet.tsx`): a panel over the current place. A bottom sheet on phones, a centred
  dialog from 720px. Title, optional subtitle and sticky footer, close button, Escape, focus trap,
  scroll lock, focus returns to the opener. Sheets stack (a card opened from the collection sits on
  top of it). Sizes: `sm` (the scoring guide, short notices such as an invalid link, Report a
  problem), `md` (one pull, share previews, the pack behind an achievement), `lg` (shared profiles,
  pack shelf), `full` (full-viewport variant, unused for now); `bare` for a single big card (the card
  viewer), which also closes on a tap on its empty space or the backdrop, never on the card or its
  text (a press must start and end there, so selecting the text never closes it).
- **Tabs** (`ui/Tabs.tsx`): text with a yellow underline, like binder dividers, when one page holds
  several lists, so only one shows at a time. Arrow keys move between tabs.
- **Set code** (`.set-code`, `setCode()`): a set's initials in its colour, next to its name in rows.
- **Verified label** (`.pull-viewer-badge`): a bordered, condensed caps strip with a cert number
  (player ID and ticket), like the label on a graded card.
- **Rows**: lists are rows (thumbnail, two lines of text, a value on the right, a chevron when it
  opens something), not cards in a grid. Sound & display uses grouped rows with `.switch` toggles.
- **App nav** (`ui/AppNav.tsx`): Open, Cards, Rankings and Profile, each an icon plus a label, the
  current one marked `aria-current="page"`. A fixed bottom bar on phones (under 900px, with
  safe-area padding) and part of the header from 900px; 44px targets. It stays hidden for a new
  player until their first pack is saved (#222) and while a pack is open. The header's gear
  ("Settings") opens the Settings page: Sound & display, Save & backup, Help (Card guide, Report a
  problem).
- **Profile** (`profile/ProfilePage.tsx`): name and the save note ("Name and rewards"), level and
  stats, best pulls, then the Achievements section (`#achievements`), which achievement toasts link
  to. Its shareable image is the "Profile card"; "Player ID" stays the name of the key's fingerprint,
  as on proofs. Leaving Profile saves a changed name, unless saving that same name just failed.
- **Rankings** (`pages/HallOfFamePage.tsx`): tabs All-time, Today and Archive. All-time is the
  published top 100 by Brainrot Score, 20 rows at a time. Today ranks the published pulls (top 100
  and world firsts) filed today on the player's own calendar, plus just-submitted ones not filed yet;
  it comes second because on a quiet day it is empty. Archive holds what isn't ranked, each under a heading that says why: world
  firsts (dated, not numbered) and the hackathon legends (screenshots from before proofs).
- **Collection eras** (`collection/CollectionBrowser.tsx`): each started era's header is a button
  inside its heading (name, era, owned count, chevron) that shows or hides its grid. The page always
  opens the era you open packs from (else the newest started one), then the other started eras newest
  first while they fit 24 pockets, and collapses the rest. A collapsed grid is unmounted, not hidden,
  so a big collection stays cheap to open (#344).
- **Toasts** (`achievements/AchievementToasts.tsx`): top centre on mobile, top right under nav on desktop, auto-dismiss.
- **Chips and badges**: era chips in the picker; rarity badges show name, colour and points.
- **Empty states**: one icon, one sentence that says what to do next.
- **Crash screen** (`ui/AppErrorBoundary.tsx`): if a render throws, a plain page with a Reload
  button (never an automatic reload) and a collapsed, copyable bug report built from the same
  allowlist as the Report a problem sheet. It shows no error text and touches no save data.
- **Selection and drag**: controls (`button`, `[role="button"]`), the pack stage, the card reveal and
  cards take no text selection, so rapid taps never highlight labels; game images set
  `draggable="false"`. Inputs, textareas, links, the pack summary, error hints, report text and
  player IDs stay selectable. Deliberate exceptions: the share preview image and the Hall of Fame
  legend image stay draggable (they are content a player may save), and only cards suppress the
  context menu. Never disable selection or context menus globally. `tests/browser/selection-drag.spec.ts`
  guards this.

## Checking a change

Run the app, then capture every screen at 360×740, 375×667, 390×844, 1280×800 and 1440×900 (a
Playwright script that opens a pack, every page and every sheet is the quickest way). Look for
overlap, cut-off text and anything that needs a mouse. Keyboard through it: Tab reaches everything,
Escape closes the top sheet, and Back walks the pages and packs in the order they were opened
(`tests/browser/pages.spec.ts`). Tab through once more with forced colours emulated (DevTools >
Rendering): every stop still shows an outline (`tests/browser/forced-colors-focus.spec.ts`).

## Proposed local Best cards contract (#337)

**Proposal for owner/Claude review, not shipped.** Keep a short list of individual card instances
on the Profile page, next to the shipped **All packs** list (its Newest / Best /
Hall of Fame tabs); no extra primary destination or global board. The heading "Best cards", its
placement and the cap of 10 are proposals for the owner to confirm. Rank by original-version
individual `cardPoints` before the pack combo multiplier, preserving finish/holo/misprint together.
Distinct slots may both qualify; repeated imports of one instance cannot duplicate it.

Use `(full public key, set id, set version, nonce, zero-based slot)` as the instance key: the full
64-hex `publicKeyHex`, and the slot in engine pack order, not reveal order. Pack history
(`brainrot-history-v1`) and the pack cache store only the first 16 hex characters of the key
(`KEY_PREFIX` in `src/game/history.ts`, `keyOf` in `src/game/packStore.ts`), so the full key must
come from the player or the proof, never from history. On equal points, order by lower nonce (as
profile highlights do, `src/engine/profile.ts`), then by higher slot (as shipped best-card picks do;
see the pull headline rule below). The local Best tab instead breaks pack ties by newer `openedAt`,
which this list must not use. Conflicting set assignments for one nonce require resolution, not two
awards. Namespace lists by full key; switching/importing an identity never merges its winners with
another key's. Local timestamps and short display fingerprints are not trusted tie/identity data.

Retain the original pack proof or a portable authoritative assignment reference, including exact
version/slot, independently of pack-history trimming (when storage is full, history drops cached
cards, then the oldest packs). Reconstruct before accepting a candidate; cached
points/cards/images are discardable. Bound the list to the cap (10, owner to confirm) and
deduplicate parent proofs, without deleting the separate profile ledger or achievement evidence
(#241/#323).

| Case | Required result |
| --- | --- |
| A 40M-point card's parent pack is trimmed from history | Card remains reconstructible with original-pack access |
| Reimported pack; equal cards in two slots | No duplicate instance; both slots eligible, higher slot first |
| Later version changes rarity/modifiers | Original version determines points and exact appearance |
| Missing cache / failed save | Reconstruct with retry; preserve prior winners and report unsaved state |
| Legacy history already missing | “Best among recoverable pulls”, not certified best-ever |

Portable saves must include required references/provenance even if stored in IndexedDB; restore
into a fresh browser must not depend on the source cache. An external different-key proof is a
viewed shared pull, not an owned opening. Public proof/generator formats remain unchanged.
Rows open shared card detail with the shipped Share card action plus a proposed View original pack;
pack detail offers a proposed Share pack (#185). Listed proofs establish those instances, not complete lifetime totals or absence of a
stronger undeclared pull. After approval, split selector/persistence/save coverage from UI wiring.
The full quota, interruption, mixed-version and round-trip acceptance matrix remains in #337;
those implementation tests are planned, not executed by this design-only change.

## Proposed pull headline rule (#339)

**Proposal, not implemented.** Choose a consistent pack headline over a dominance threshold:
**Pack total: [score]**, then **[true combo] ×[multiplier]**, then **Standout card: [finish] [Holo]
[Misprint] [name] · [card points]** (omit absent modifiers). Card surfaces lead with identity/modifiers
and Card points. The labels "Pack total", "Standout card" and "Card points" are proposals for the
owner to confirm, not shipped UI text. Individual points exclude the pack multiplier; neither title
claims record rarity. Select maximum original-version `cardPoints`; on ties take the **higher** slot
(the last of the tied cards in engine pack order). That is the shipped best-card rule: `revealOrder`
(`src/game/reveal.ts`) sorts by `cardPoints` ascending and keeps pack order on ties, and `previewOf`
(`src/game/previewLinks.ts`, called from `previewFor` in `src/game/pulls.ts`) takes its last card
when nothing matches. Reuse scoring, not cached collection counters. No Matches stays visible because
it explains the formula, not pull excitement.

Arithmetic presentation fixtures below are not claimed mined proofs. Different letters are
separate card ids; names and modifiers must come from actual reconstruction in implementation.

| Fixture | Pack total / combo | Standout |
| --- | --- | --- |
| Common Diamond Holo Misprint A40M; B20 C35 D70 E200 | 40,000,325 / No Matches ×1 | A · 40,000,000 |
| A40M A10 B20 B20 C35 | 400,000,850 / Two Pair ×10 | Slot 0 A · 40,000,000, not 400M |
| Five common A10 | 500,000 / 5 of a Kind ×10,000 | Slot 4 A · 10 |
| A35 B35 C10 D20 E10 | 110 / No Matches ×1 | Slot 1 B wins the tie |
| A10 B20 C35 D70 E200 | 335 / No Matches ×1 | E · 200 |
| Historical version | Its reconstructed total/combo | No later rarity/modifier assumptions |

One presentation helper returns structured total/combo/standout fields, without a second scorer.
Results and owned/public pack detail show all fields above cards; personal/global pack rows show
total, combo and concise standout, opening that detail. Card rows/detail show card identity/points
and labeled original-pack context. Exact-pull captions/posters use the same fields and proof link.
Static previews cannot read proof fragments: keep generic hand/card descriptions, stable paths and
old images; do not imply they depict exact modifiers or regenerate history solely for new titles.

At narrow/short widths, wrap the standout and keep actions reachable. Compact 40M formatting needs
exact accessible points and full details; rankings use exact values. After approval, implement the
helper plus consumer regressions across these surfaces. Scoring, generators, selectors, public proof
URLs and animations do not change. Full surface/mobile/sharing acceptance stays in #339; checks are
planned, not executed here. Figma authoring (#312) remains deferred.
