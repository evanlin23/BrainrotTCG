# Paws & Fries: image credits

Draft set (7 of 12 cards). Each card shows a real meme image. I downloaded each one on 2026-11-03 into its own empty
folder and checked it with Pillow, then re-encoded it to PNG (which strips metadata) and cropped it toward the art
window's 6:7 portrait shape. Code adds the frame, title and caption. The owners listed below keep all rights. The set
is still a draft, and tone, rights and art need the owner's approval before `draft` comes off.

Five slots are not final: one Rare and three Common are open for the Nov 7 trend-scout pass, and the Uncommon
Hypergamy Chart is not in yet (see "Open slots").

| Card | Source page | Image URL | Creator / owner | Notes |
| --- | --- | --- | --- | --- |
| Scientists Reveal the Hi (`scientists-reveal-the-hi`) | https://knowyourmeme.com/memes/scientists-reveal-the-hi | https://i.kym-cdn.com/entries/icons/original/000/057/623/srth.jpg | BBC News video thumbnail with the orange cat (BBC); the phrase is a meme edit by unknown users | KYM's main image, cropped to the cat and the headline area it sits in. The thumbnail is a news graphic, so rights sit with the BBC. No real person is shown. |
| Liberty Biberty (`liberty-biberty`) | https://knowyourmeme.com/memes/liberty-biberty | https://i.kym-cdn.com/entries/icons/original/000/057/696/libbibcover.jpg | The Liberty Biberty puppet, a Liberty Mutual brand mascot (Liberty Mutual Insurance); credited official or press still | KYM's main image, cropped wide to the puppet and its crown (617x720). A fragment of the brand's logo is still visible in the art. This is a corporate mascot, so brand rights are the main risk. The backlash began in July 2026 and the October wave was the breakout. No real person is shown. Pack hero. |
| Saitama vs. Goku (`saitama-vs-goku`) | https://knowyourmeme.com/memes/saitama-vs-goku | https://i.kym-cdn.com/entries/icons/original/000/057/640/gokusaitamacover.jpg | Death Battle thumbnail (ScrewAttack / Rooster Teeth). Saitama, *One-Punch Man* (ONE / Yusuke Murata / Shueisha); Goku, *Dragon Ball* (Akira Toriyama / Shueisha / Toei) | Cropped to the two fighters (385x449), with the thumbnail text left out. Both are fictional characters. |
| Snow Leopard Paws At You (`snow-leopard-paws-at-you`) | https://knowyourmeme.com/memes/snow-leopard-paws-at-you | https://i.kym-cdn.com/photos/images/original/003/338/839/76d.jpg | Zoo photo by @black03_white03 (credited as the source of the snow leopard shot); the "Snowmei" face-swap edit onto the Mei Mei image is by an unknown editor | This is the canonical edit as shown on KYM, taken from a tweet screenshot and cropped to the animal (384x457). The editor is unknown and the image is soft. The zoo photo's author is credited above. No real person is shown. |
| Randy Marsh (`randy-marsh`) | https://knowyourmeme.com/memes/randy-marsh-vs-whats-up-brah | https://i.kym-cdn.com/entries/icons/original/000/057/603/wubcover.jpg | Still from *South Park* (Trey Parker and Matt Stone; Paramount / Comedy Partners) | KYM's main image, cropped to Randy (617x720). He is a cartoon character. South Park's owner is active about its content, so this is a rights risk to review. |
| Ronnie Coleman Fries (`ronnie-coleman-fries`) | https://knowyourmeme.com/memes/ronnie-coleman-french-fries-video | https://i.kym-cdn.com/entries/icons/original/000/057/635/rcfriescover.jpg | Still from Ronnie Coleman's *Club Shay Shay* interview (Shannon Sharpe); Ronnie Coleman is the person shown | KYM's main image, cropped (480x560) to cut out the DraftKings watermark and the Club Shay Shay logo. Coleman is a public figure (eight-time Mr. Olympia) and a real person is shown. The card caption refers to his own remark about the fries and does not mock him. |
| Fat Talking Tom and Angela (`fat-talking-tom-and-angela`) | https://knowyourmeme.com/memes/fat-talking-tom-and-angela | https://i.kym-cdn.com/photos/images/original/003/332/951/ca5.jpg | *Talking Tom and Friends* characters © Outfit7; the "fat" edit is by unknown users | The canonical image is a two-panel; the card shows the Tom panel only (888x1036, resized). That is why the card name still reads "and Angela". Both are cartoon characters. |

## Open slots

- One Rare and three Common are open. They will be filled from the Nov 7 trend-scout pass in this same PR. No lookalike
  or placeholder art is used in the meantime.
- **Hypergamy Chart (Uncommon)** is left out. The art has to be the mocking frog-off-a-cliff edit by @alestro_here or the
  Oct 14 cloud edit, as a credited still. I could not get either file from a source I am allowed to use, and the bare
  chart is not acceptable art. It stays open until the owner supplies a file or a permitted source is found.

## Pack hero

Liberty Biberty is the hero, cut from the card art with `scripts/cards/cut-stickers.py` (rembg isnet-general-use). The
puppet fills the crop, so its fur touches two picture edges and the grader flags the cut as scenery. I added a `'die'`
override for this one card in that script. The cut is slightly ragged at the bottom left.
