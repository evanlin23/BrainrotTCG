"""
Cut each set's pack hero from the set's own card art.

The booster pack wrapper (scripts/cards/pack.ts) shows one hero character per set, die-cut and blended
into the pouch, above the set's name. The hero is named in scripts/cards/pack-heroes.json. Finding a
character's outline takes an ML matting model, so that step lives here, run by hand, and its output is
committed; the build only composites committed files and stays deterministic.

For the hero's image in src/content/sets/<set>/art/ (a full `.card.*` image is cropped to the Genesis
art window first, so no frame or title gets in):

1. rembg (model isnet-general-use) gives a soft foreground alpha.
2. The main subject is kept: the largest connected part, holes filled, edge smoothed.
3. The cut is graded. Fragmented, tiny, or mostly scenery cuts are refused with a message, unless
   OVERRIDES below says the cut is right.

Writes src/content/sets/<set>/stickers/index.json (the hero's art file, the crop in that file's
pixels and the grades) and <hero>.png: a 1-bit mask of the crop, at most MASK_SIZE px on its long side.

Run (Python 3.13, the pinned packages in stickers-requirements.txt):
  python3 scripts/cards/cut-stickers.py [--set <id>] [--force]
A set whose index.json already holds the hero with the same art bytes is left alone unless --force.
"""
import argparse
import glob
import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SETS = os.path.join(ROOT, 'src', 'content', 'sets')
MODEL = 'isnet-general-use'
TOOL = 'cut-stickers.py v1 (rembg 2.0.86, isnet-general-use)'
MASK_SIZE = 360
EXTS = ('png', 'jpg', 'jpeg', 'webp')

# Hand calls where the grades get the hero wrong: 'die' accepts the cut. Keyed by set id, then card id.
# Keep it short and say why.
OVERRIDES: dict[str, dict[str, str]] = {
    # The largest part is the gorilla, which is the hero; the hundred men are scenery.
    'six-seven-season': {'100-men-vs-1-gorilla': 'die'},
}

# Grades (shares of the crop's area, or of the foreground's).
MIN_SUBJECT = 0.05  # smaller than this is a speck
MAX_SUBJECT = 0.78  # bigger than this is the whole picture, not a subject
MIN_MAIN_SHARE = 0.80  # the largest part's share of all confident foreground
MAX_EDGES = 2  # touching 3 or 4 picture edges is scenery
MIN_SOLIDITY = 0.3  # subject area over its bounding box's: below it, stringy or scattered


def art_files(set_id):
    out = {}
    for path in sorted(glob.glob(os.path.join(SETS, set_id, 'art', '*'))):
        name = os.path.basename(path)
        stem, _, ext = name.rpartition('.')
        if ext.lower() not in EXTS:
            continue
        full = stem.endswith('.card')
        card = stem[: -len('.card')] if full else stem
        # Same order as scripts/cards/lib.ts findArt: a full card wins over a bare illustration.
        if card in out and not full:
            continue
        out[card] = (path, full)
    return out


def art_window(size):
    """The Genesis frame's art window, scaled to this image, inset past the frame's ragged edge."""
    layout = json.load(open(os.path.join(HERE, 'templates', 'genesis-frame.json')))
    sx = size[0] / layout['width']
    sy = size[1] / layout['height']
    a = layout['art']
    inset = 14
    return (
        round((a['x'] + inset) * sx),
        round((a['y'] + inset) * sy),
        round((a['width'] - 2 * inset) * sx),
        round((a['height'] - 2 * inset) * sy),
    )


def main_subject(alpha):
    """Largest confident part, holes filled, edge smoothed. Returns the mask and the grades."""
    h, w = alpha.shape
    fg = alpha > 0.5
    labels, n = ndimage.label(fg, structure=np.ones((3, 3)))
    if n == 0:
        return np.zeros_like(fg), {'subject': 0.0, 'mainShare': 0.0, 'edges': 0, 'solidity': 0.0}
    areas = ndimage.sum(fg, labels, range(1, n + 1))
    main = labels == (int(np.argmax(areas)) + 1)
    main = ndimage.binary_fill_holes(main)
    # Smooth: blur and re-threshold (rounds off jaggies and hair-thin spurs), then fill again.
    sigma = max(2.0, 0.006 * (w + h))
    main = ndimage.gaussian_filter(main.astype(np.float32), sigma) > 0.5
    labels, n = ndimage.label(main, structure=np.ones((3, 3)))
    if n > 1:
        areas2 = ndimage.sum(main, labels, range(1, n + 1))
        main = labels == (int(np.argmax(areas2)) + 1)
    main = ndimage.binary_fill_holes(main)
    area = float(main.sum())
    ys, xs = np.nonzero(main)
    edges = 0
    if area:
        margin = 3
        edges = int(xs.min() <= margin) + int(ys.min() <= margin) + int(xs.max() >= w - 1 - margin) + int(ys.max() >= h - 1 - margin)
        box = (xs.max() - xs.min() + 1) * (ys.max() - ys.min() + 1)
    grades = {
        'subject': round(area / (w * h), 3),
        'mainShare': round(float(areas.max()) / float(fg.sum()), 3),
        'edges': edges,
        'solidity': round(float(area / box), 3) if area else 0.0,
    }
    return main, grades


def verdict(grades):
    if grades['subject'] < MIN_SUBJECT:
        return 'tiny'
    if grades['mainShare'] < MIN_MAIN_SHARE:
        return 'fragmented'
    if grades['subject'] > MAX_SUBJECT or grades['edges'] > MAX_EDGES:
        return 'scenery'
    if grades['solidity'] < MIN_SOLIDITY:
        return 'stringy'
    return None


def cut_card(session, remove, set_id, card, path, full):
    image = Image.open(path).convert('RGB')
    window = art_window(image.size) if full else (0, 0, image.width, image.height)
    x0, y0, ww, wh = window
    crop = image.crop((x0, y0, x0 + ww, y0 + wh))
    alpha = np.asarray(remove(crop, session=session, only_mask=True), dtype=np.float32) / 255.0
    mask, grades = main_subject(alpha)
    bad = verdict(grades)
    override = OVERRIDES.get(set_id, {}).get(card)
    if bad and override != 'die':
        sys.exit(f'{set_id}/{card}: the cut is {bad} {grades}; pick another hero in pack-heroes.json, or add an OVERRIDES entry if the cut is right')
    entry = {'art': os.path.relpath(path, os.path.join(SETS, set_id)).replace(os.sep, '/'), 'kind': 'die', 'grades': grades}
    if bad:
        entry['flag'] = bad
    if override:
        entry['override'] = True
    ys, xs = np.nonzero(mask)
    pad = round(0.02 * max(ww, wh))
    bx0, by0 = max(int(xs.min()) - pad, 0), max(int(ys.min()) - pad, 0)
    bx1, by1 = min(int(xs.max()) + 1 + pad, ww), min(int(ys.max()) + 1 + pad, wh)
    entry['crop'] = [x0 + bx0, y0 + by0, bx1 - bx0, by1 - by0]
    sub = Image.fromarray((mask[by0:by1, bx0:bx1] * 255).astype(np.uint8), 'L')
    scale = min(1.0, MASK_SIZE / max(sub.size))
    size = (max(1, round(sub.width * scale)), max(1, round(sub.height * scale)))
    out_mask = sub.resize(size, Image.LANCZOS).point(lambda v: 255 if v >= 128 else 0).convert('1')
    entry['mask'] = f'{card}.png'
    return entry, out_mask


def digest(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()[:16]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--set')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    from rembg import new_session, remove

    heroes = json.load(open(os.path.join(HERE, 'pack-heroes.json')))
    session = None
    set_ids = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(os.path.join(SETS, '*', 'set.json')))
    if args.set:
        set_ids = [s for s in set_ids if s == args.set]
        if not set_ids:
            sys.exit(f'No set {args.set}')
    for set_id in set_ids:
        card = heroes.get(set_id)
        if card is None:
            sys.exit(f'{set_id}: no hero in pack-heroes.json')
        arts = art_files(set_id)
        if card not in arts:
            sys.exit(f'{set_id}: the hero {card} has no art in {set_id}/art')
        path, full = arts[card]
        out_dir = os.path.join(SETS, set_id, 'stickers')
        index_path = os.path.join(out_dir, 'index.json')
        source = digest(path)
        if not args.force and os.path.exists(index_path):
            old = json.load(open(index_path))
            if old.get('tool') == TOOL and {c: e.get('source') for c, e in old['stickers'].items()} == {card: source} and old.get('overrides') == OVERRIDES.get(set_id, {}):
                print(f'{set_id}: up to date')
                continue
        if session is None:
            session = new_session(MODEL)
        os.makedirs(out_dir, exist_ok=True)
        for stale in glob.glob(os.path.join(out_dir, '*.png')):
            os.remove(stale)
        entry, mask = cut_card(session, remove, set_id, card, path, full)
        entry['source'] = source
        mask.save(os.path.join(out_dir, entry['mask']), optimize=True)
        print(f"{set_id}/{card}: {entry['grades']}")
        index = {'tool': TOOL, 'overrides': OVERRIDES.get(set_id, {}), 'stickers': {card: entry}}
        with open(index_path, 'w') as fh:
            json.dump(index, fh, indent=2)
            fh.write('\n')


if __name__ == '__main__':
    main()
