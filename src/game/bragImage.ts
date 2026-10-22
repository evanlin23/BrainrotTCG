/**
 * A 1080×1920 (9:16) "pull poster" for TikTok, Reels, Shorts and Stories:
 * the five cards, the hand and value, who pulled it, and a QR code that opens
 * the verifiable pull. Drawn on a canvas from same-origin card images.
 */
import type { Finish, PackScore } from '../engine';
import { FINISH_INFO, modifierLabel } from './modifiers';
import { holdFinishedCardImage } from './finishImage';
import { planQr, QR_QUIET, type QrPlan } from './qrCode';
import { BLANK_CARD_ART, isApprovedCardArt } from './cardArt';
import { LOGO_MARK_PATH, LOGO_MARK_SIZE } from '../styles/logoMark';
import { BRAND as YELLOW, CHIP_BG, FINISH_GLOWS, FOIL_STOPS, INK, MUTED, PAPER } from '../styles/palette';

export interface PosterCard {
  image: string;
  name: string;
  isHolo: boolean;
  finish?: Finish | null;
  misprint?: boolean;
}

export interface PosterInput {
  cards: PosterCard[];
  score: PackScore;
  setName: string;
  playerName: string;
  fingerprint: string;
  url: string;
  /** Printed on the label like a grading cert, e.g. "SOS #42". */
  cert?: string;
  /** The set's colour, for its code chip. */
  setColor?: string;
  /** Max time to wait for each card image before failing. */
  timeoutMs?: number;
}

const W = 1080;
const H = 1920;

/** Allow slow mobile networks without leaving the poster stuck on "Drawing the image…" indefinitely. */
export const POSTER_IMAGE_TIMEOUT_MS = 10_000;

export const loadPosterImageElement = (
  src: string,
  timeoutMs = POSTER_IMAGE_TIMEOUT_MS,
): Promise<HTMLImageElement> =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      img.onload = null;
      img.onerror = null;
      if (error) {
        img.src = '';
        reject(error);
      } else {
        resolve(img);
      }
    };
    const timeout = setTimeout(() => settle(new Error(`Poster image load timed out: ${src}`)), timeoutMs);
    img.onload = () => settle();
    img.onerror = () => settle(new Error(`Could not load ${src}`));
    img.src = src;
  });

const loadImage = async (art: string, wanted?: Finish | null, timeoutMs = POSTER_IMAGE_TIMEOUT_MS) => {
  // Art this build won't request (an unknown historical card's stored address) is drawn as an empty slot.
  const approved = isApprovedCardArt(art);
  const src = approved ? art : BLANK_CARD_ART;
  const finish = approved ? wanted : null;
  const finished = holdFinishedCardImage(src, finish);
  try {
    const imageUrl = await finished.image;
    return await loadPosterImageElement(imageUrl, timeoutMs);
  } finally {
    // A loaded image keeps its pixels, so the render can be evicted while the poster is drawn.
    finished.release();
  }
};

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  // Older browsers (e.g. Firefox before 112) have no roundRect.
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

/** The in-game ghost's hue-rotate(150deg) saturate(2.2), including browsers without canvas filters. */
const misprintGhost = (img: HTMLImageElement, w: number, h: number): HTMLCanvasElement => {
  const ghost = document.createElement('canvas');
  ghost.width = Math.ceil(w);
  ghost.height = Math.ceil(h);
  const ctx = ghost.getContext('2d')!;
  ctx.drawImage(img, 0, 0, ghost.width, ghost.height);
  const pixels = ctx.getImageData(0, 0, ghost.width, ghost.height);
  const c = Math.cos(150 * Math.PI / 180);
  const s = Math.sin(150 * Math.PI / 180);
  const clamp = (value: number) => Math.max(0, Math.min(255, value));
  for (let i = 0; i < pixels.data.length; i += 4) {
    const r = pixels.data[i];
    const g = pixels.data[i + 1];
    const b = pixels.data[i + 2];
    // CSS hue rotation matrix, then saturation around the rotated pixel's luminance.
    const red = clamp((0.213 + 0.787 * c - 0.213 * s) * r + (0.715 - 0.715 * c - 0.715 * s) * g + (0.072 - 0.072 * c + 0.928 * s) * b);
    const green = clamp((0.213 - 0.213 * c + 0.143 * s) * r + (0.715 + 0.285 * c + 0.140 * s) * g + (0.072 - 0.072 * c - 0.283 * s) * b);
    const blue = clamp((0.213 - 0.213 * c - 0.787 * s) * r + (0.715 - 0.715 * c + 0.715 * s) * g + (0.072 + 0.928 * c + 0.072 * s) * b);
    const luminance = 0.213 * red + 0.715 * green + 0.072 * blue;
    pixels.data[i] = luminance + 2.2 * (red - luminance);
    pixels.data[i + 1] = luminance + 2.2 * (green - luminance);
    pixels.data[i + 2] = luminance + 2.2 * (blue - luminance);
  }
  ctx.putImageData(pixels, 0, 0);
  return ghost;
};

const drawCard = (ctx: CanvasRenderingContext2D, img: HTMLImageElement, card: PosterCard, cx: number, cy: number, w: number, angle: number) => {
  const h = (w * 1024) / 687;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 10;
  roundRect(ctx, -w / 2, -h / 2, w, h, 14);
  if (card.finish === 'PLATINUM' || card.finish === 'DIAMOND') {
    // Draw the soft finish glow outside the card before clipping its image.
    ctx.save();
    ctx.shadowOffsetY = 0;
    ctx.shadowColor = FINISH_GLOWS[card.finish];
    ctx.shadowBlur = w * (card.finish === 'PLATINUM' ? 0.06 : 0.085);
    ctx.fillStyle = INK;
    ctx.fill();
    if (card.finish === 'DIAMOND') {
      ctx.shadowColor = FINISH_GLOWS.DIAMOND_2;
      ctx.shadowBlur = w * 0.19;
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.clip();
  if (card.misprint) {
    // Match Card.css: tilted/scaled base, then a shifted wrong-ink pass ABOVE it.
    ctx.save();
    ctx.rotate(-1.5 * Math.PI / 180);
    ctx.scale(1.03, 1.03);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
    ctx.save();
    ctx.shadowColor = 'transparent';
    ctx.translate(w * 0.04, h * 0.02);
    ctx.rotate(Math.PI / 180);
    ctx.globalAlpha = 0.45;
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(misprintGhost(img, w, h), -w / 2, -h / 2, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
  }
  if (card.isHolo) {
    // Foil: the only gradient on the poster, as in the app.
    const shine = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
    FOIL_STOPS.forEach((c, i) => shine.addColorStop(i / 5, c));
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = shine;
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
  // Name what's special about it on the card's bottom edge, like the sticker in the game.
  const label = modifierLabel(card, false).toUpperCase();
  if (label) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const size = Math.round(Math.max(20, w * 0.075));
    ctx.font = `800 ${size}px ${BODY_FONT}`;
    ctx.textAlign = 'center';
    const tw = Math.min(w * 0.9, ctx.measureText(label).width + size);
    const lh = size * 1.5;
    const y = h / 2 - lh - w * 0.05;
    ctx.fillStyle = CHIP_BG;
    roundRect(ctx, -tw / 2, y, tw, lh, 6);
    ctx.fill();
    ctx.fillStyle = card.finish ? FINISH_INFO[card.finish].color : '#ffffff';
    ctx.fillText(label, 0, y + lh * 0.72, w * 0.85);
  }
  ctx.restore();
};

/** Draws a verified code (see planQr) on whole-pixel cells, so what was decoded is what is exported. */
const drawQr = (ctx: CanvasRenderingContext2D, qr: QrPlan, x: number, y: number) => {
  ctx.fillStyle = PAPER;
  roundRect(ctx, x, y, qr.side, qr.side, 6);
  ctx.fill();
  ctx.fillStyle = INK;
  for (let r = 0; r < qr.count; r++) {
    for (let c = 0; c < qr.count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(x + (c + QR_QUIET) * qr.cell, y + (r + QR_QUIET) * qr.cell, qr.cell, qr.cell);
    }
  }
};

/** Set ctx.font to the largest size (<= size) at which the text fits, never below minSize. */
const fitFont = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
  weight: string,
  family: string,
  minSize = 20,
) => {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && s > minSize) {
    s = Math.max(minSize, s - 2);
    ctx.font = `${weight} ${s}px ${family}`;
  }
};

/** User-perceived characters, so a cut never lands inside a surrogate pair or a joined sequence. */
type Segmenter = new (locale?: string, options?: { granularity: 'grapheme' }) => { segment: (text: string) => Iterable<{ segment: string }> };

const graphemes = (text: string): string[] => {
  const Seg = (Intl as unknown as { Segmenter?: Segmenter }).Segmenter;
  return Seg ? Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment) : Array.from(text);
};

/**
 * `text` cut at a character boundary and ended with an ellipsis until it measures within maxWidth
 * in the current font. Text that already fits is returned unchanged; display only, never stored.
 */
export const ellipsize = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string => {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = graphemes(text);
  while (chars.length > 0) {
    chars.pop();
    const cut = `${chars.join('').trimEnd()}\u2026`;
    if (ctx.measureText(cut).width <= maxWidth) return cut;
  }
  return '\u2026';
};

/**
 * Set the font for a one-line label and return what to draw: the text itself at the largest size
 * (<= size, >= minSize) that fits, or, for a name wider than maxWidth even at minSize, its start and an ellipsis.
 */
export const fitLabelText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
  weight: string,
  family: string,
  minSize = 20,
): string => {
  fitFont(ctx, text, maxWidth, size, weight, family, minSize);
  return ellipsize(ctx, text, maxWidth);
};

/** Split parts into lines (joined with " · ") that each measure within maxWidth in the current font. */
export const wrapParts = (ctx: CanvasRenderingContext2D, parts: string[], maxWidth: number, separator = ' \u00b7 '): string[] => {
  const lines: string[] = [];
  for (const part of parts) {
    const last = lines.length - 1;
    if (last >= 0 && ctx.measureText(`${lines[last]}${separator}${part}`).width <= maxWidth) lines[last] += `${separator}${part}`;
    else lines.push(part);
  }
  return lines;
};

const LOGO_FONT = '"RubikGlitch", system-ui, sans-serif';
const DISPLAY_FONT = '"Lilita One", system-ui, sans-serif';
const BODY_FONT = '"Archivo Variable", system-ui, -apple-system, "Segoe UI", sans-serif';

/** A binder-black 1080x1920 canvas with the app's fonts loaded. */
const newCanvas = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  await Promise.all([
    document.fonts?.load('110px "RubikGlitch"'),
    document.fonts?.load('96px "Lilita One"'),
    document.fonts?.load('800 40px "Archivo Variable"'),
  ]).catch(() => undefined);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  return { canvas, ctx };
};

const LOGO_SIZE = 104;
/** The mark's size, drop below the baseline and gap before the wordmark, in ems as the header's CSS. */
const MARK = { size: 0.8 * LOGO_SIZE, drop: 0.04 * LOGO_SIZE, gap: 0.3 * LOGO_SIZE };

/**
 * The logo, centred on its baseline: the mark and the wordmark in card-stock white, each with a
 * hard yellow misprint offset. The mark is a path, so nothing is fetched; without Path2D (jsdom)
 * the wordmark is drawn alone.
 */
export const drawLogo = (ctx: CanvasRenderingContext2D, baseline: number) => {
  const text = 'BRAINROT TCG';
  ctx.font = `${LOGO_SIZE}px ${LOGO_FONT}`;
  ctx.textAlign = 'left';
  const mark = typeof Path2D === 'undefined' ? null : new Path2D(LOGO_MARK_PATH);
  const markWidth = mark ? MARK.size + MARK.gap : 0;
  const left = (W - markWidth - ctx.measureText(text).width) / 2;
  for (const [offset, colour] of [[8, YELLOW], [0, PAPER]] as const) {
    ctx.fillStyle = colour;
    if (mark) {
      ctx.save();
      ctx.translate(left + offset, baseline + MARK.drop - MARK.size + offset);
      ctx.scale(MARK.size / LOGO_MARK_SIZE, MARK.size / LOGO_MARK_SIZE);
      ctx.fill(mark);
      ctx.restore();
    }
    ctx.fillText(text, left + markWidth + offset, baseline + offset);
  }
};

/** The logo, then the set's code and name. */
const drawHeader = (ctx: CanvasRenderingContext2D, setName: string, code: string, setColor?: string) => {
  drawLogo(ctx, 160);

  ctx.font = `700 44px ${BODY_FONT}`;
  const nameWidth = ctx.measureText(setName).width;
  ctx.font = `800 34px ${BODY_FONT}`;
  const codeWidth = code ? ctx.measureText(code).width : 0;
  let x = (W - (codeWidth + (code ? 22 : 0) + nameWidth)) / 2;
  ctx.textAlign = 'left';
  // The set code is printed plainly, the way a card prints it; the set's colour is a thin rule under it.
  if (code) {
    ctx.fillStyle = MUTED;
    ctx.fillText(code, x, 236);
    ctx.fillStyle = setColor ?? MUTED;
    ctx.fillRect(x, 248, codeWidth, 5);
    x += codeWidth + 22;
  }
  ctx.fillStyle = PAPER;
  ctx.font = `700 44px ${BODY_FONT}`;
  ctx.fillText(setName, x, 238);
};

/** A graded-card label: what it is, who, the cert, and (when there's a link) the QR that re-checks it. */
/** Clear space between the label's text and its QR code. */
const LABEL_QR_GAP = 24;

const drawLabel = async (
  ctx: CanvasRenderingContext2D,
  label: { kind: string; verified: boolean; name: string; cert: string; hint: string; url?: string },
) => {
  const x = 70;
  const y = 1570;
  const w = W - 140;
  const h = 290;
  // Verified: cream label stock with dark print, like a graded card. Otherwise an outline.
  const ink = label.verified ? INK : PAPER;
  const soft = label.verified ? '#5c5660' : MUTED;
  if (label.verified) {
    ctx.fillStyle = PAPER;
    roundRect(ctx, x, y, w, h, 6);
    ctx.fill();
  } else {
    ctx.strokeStyle = MUTED;
    ctx.lineWidth = 4;
    roundRect(ctx, x, y, w, h, 6);
    ctx.stroke();
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = soft;
  ctx.font = `800 30px ${BODY_FONT}`;
  ctx.fillText(label.kind.toUpperCase(), x + 40, y + 64);
  // A link too dense to read back from the drawn code gets no code, only the line saying so.
  const qr = label.url ? await planQr(label.url) : null;
  // The name stops short of the code (drawn last, at x + w - 40 - side) however wide it is.
  const textWidth = qr ? w - 80 - qr.side - LABEL_QR_GAP : w - 80;
  ctx.fillStyle = ink;
  const name = fitLabelText(ctx, label.name, textWidth, 52, '800', BODY_FONT);
  ctx.fillText(name, x + 40, y + 134, textWidth);
  ctx.fillStyle = soft;
  ctx.font = `600 32px ${BODY_FONT}`;
  ctx.fillText(label.cert, x + 40, y + 186);
  ctx.font = `500 28px ${BODY_FONT}`;
  // No code that provably scans: the link travels with the image instead.
  ctx.fillText(label.url && !qr ? 'Open the link sent with this to check it.' : label.hint, x + 40, y + 242);
  if (qr) drawQr(ctx, qr, x + w - 40 - qr.side, y + Math.round((h - qr.side) / 2));
};

const toPng = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), 'image/png'));

/** The whole pack: five cards, the hand and score, and a label that links to the verifiable pull. */
export const renderPoster = async (input: PosterInput): Promise<Blob> => {
  const { canvas, ctx } = await newCanvas();
  const code = (input.cert ?? '').split(' ')[0];
  drawHeader(ctx, input.setName, code, input.setColor);

  // Cards: three on top, two below, slightly fanned.
  const images = await Promise.all(input.cards.map((c) => loadImage(c.image, c.finish, input.timeoutMs)));
  const slots = [
    { x: 215, y: 620, a: -0.06 },
    { x: 540, y: 600, a: 0 },
    { x: 865, y: 620, a: 0.06 },
    { x: 380, y: 1070, a: -0.04 },
    { x: 700, y: 1070, a: 0.04 },
  ];
  input.cards.forEach((card, i) => {
    const slot = slots[i] ?? slots[slots.length - 1];
    drawCard(ctx, images[i], card, slot.x, slot.y, 300, slot.a);
  });

  const { hand, score } = input.score;
  ctx.textAlign = 'center';
  ctx.fillStyle = PAPER;
  fitFont(ctx, hand.name, W - 120, 104, 'normal', DISPLAY_FONT);
  ctx.fillText(hand.name, W / 2, 1430);
  ctx.fillStyle = MUTED;
  ctx.font = `600 40px ${BODY_FONT}`;
  ctx.fillText(`${score.toLocaleString('en-US')} Brainrot Score`, W / 2, 1500);

  await drawLabel(ctx, {
    kind: 'Verifiable pull',
    verified: true,
    name: input.playerName,
    cert: `Cert ${input.fingerprint}${input.cert ? ` · ${input.cert}` : ''}`,
    hint: 'Scan to re-open this exact pack.',
    url: input.url,
  });
  return toPng(canvas);
};

export interface CardPosterInput {
  card: PosterCard & { rarityName: string; raritySymbol: string; rarityColor: string; number: string };
  setName: string;
  setCode: string;
  setColor?: string;
  playerName: string;
  fingerprint: string;
  /** The verifiable pull this card came from, if this device has one. */
  url?: string;
  cert?: string;
  /** Points and pack odds for this version, e.g. "400 pts · 1 in 2,400 packs". */
  stats?: string;
  /** Max time to wait for the card image before failing. */
  timeoutMs?: number;
}

/** Smallest size the rarity line shrinks to on one line before it wraps; the wrapped lines use WRAP_SIZE. */
const RARITY_MIN_SIZE = 34;
const RARITY_WRAP_SIZE = 36;

/**
 * Rarity, every modifier and the collector number as one line that fits maxWidth, set in ctx.font.
 * Long combinations shrink to RARITY_MIN_SIZE, then wrap between parts; no part is ever dropped.
 */
export const fitRarityLines = (ctx: CanvasRenderingContext2D, parts: string[], maxWidth: number): string[] => {
  const line = parts.join(' \u00b7 ');
  fitFont(ctx, line, maxWidth, 40, '700', BODY_FONT, RARITY_MIN_SIZE);
  if (ctx.measureText(line).width <= maxWidth) return [line];
  ctx.font = `700 ${RARITY_WRAP_SIZE}px ${BODY_FONT}`;
  return wrapParts(ctx, parts, maxWidth);
};

/** One card, big: its name, rarity and collector number, and the pull it came from when there is one. */
export const renderCardPoster = async (input: CardPosterInput): Promise<Blob> => {
  const { canvas, ctx } = await newCanvas();
  drawHeader(ctx, input.setName, input.setCode, input.setColor);

  const image = await loadImage(input.card.image, input.card.finish, input.timeoutMs);
  drawCard(ctx, image, input.card, W / 2, 790, 620, 0);

  ctx.textAlign = 'center';
  ctx.fillStyle = PAPER;
  fitFont(ctx, input.card.name, W - 120, 96, 'normal', DISPLAY_FONT);
  ctx.fillText(input.card.name, W / 2, 1385);
  const mods = modifierLabel(input.card);
  const parts = [
    `${input.card.raritySymbol} ${input.card.rarityName}`,
    ...(mods ? mods.split(' \u00b7 ') : []),
    `${input.setCode} ${input.card.number}`,
  ];
  const rarityLines = fitRarityLines(ctx, parts, W - 120);
  ctx.fillStyle = input.card.rarityColor;
  rarityLines.forEach((line, i) => ctx.fillText(line, W / 2, (rarityLines.length > 1 ? 1458 : 1470) + i * 42, W - 120));
  if (input.stats) {
    ctx.font = `600 34px ${BODY_FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(input.stats, W / 2, rarityLines.length > 1 ? 1544 : 1530, W - 140);
  }

  await drawLabel(ctx, {
    kind: input.url ? 'Verifiable pull' : 'From the collection of',
    verified: !!input.url,
    name: input.playerName,
    cert: input.url ? `Cert ${input.fingerprint}${input.cert ? ` · ${input.cert}` : ''}` : `#${input.fingerprint}`,
    hint: input.url ? 'Scan to re-open the pack it came from.' : 'No pack record on this device.',
    url: input.url,
  });
  return toPng(canvas);
};

export interface ProfilePosterInput {
  playerName: string;
  fingerprint: string;
  level: number;
  title: string;
  /** XP now, and the XP where this level started and the next one starts. */
  xp: number;
  levelXp: number;
  nextLevelXp: number;
  packs: number;
  unique: number;
  totalCards: number;
  holos: number;
  bestScore: number;
  /** Collection Brainrot Score, the milestone reached and the next one. */
  points: number;
  milestone?: string;
  nextMilestone?: { name: string; points: number };
  milestoneFloor: number;
  /** Every set, in timeline order, with how far it's done. */
  sets: { code: string; color?: string; have: number; size: number; done: 'complete' | 'master' | null }[];
  best?: { cards: PosterCard[]; hand: string; score: number; setName: string };
  /** The profile link (its QR re-checks every pack). */
  url?: string;
  /** Max time to wait for each card image before failing. */
  timeoutMs?: number;
}

const bar = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, fraction: number) => {
  ctx.fillStyle = 'rgba(243, 239, 230, 0.12)';
  roundRect(ctx, x, y, w, 14, 7);
  ctx.fill();
  ctx.fillStyle = YELLOW;
  roundRect(ctx, x, y, Math.max(14, w * Math.min(1, Math.max(0, fraction))), 14, 7);
  ctx.fill();
};

/** A profile card: level and title, the numbers, set progress, the best pull, and a QR to the profile. */
export const renderProfilePoster = async (input: ProfilePosterInput): Promise<Blob> => {
  const { canvas, ctx } = await newCanvas();
  drawHeader(ctx, 'Profile card', '');
  const x = 70;
  const w = W - 140;
  const fmt = (n: number) => n.toLocaleString('en-US');

  // Name, level and title, XP to the next level.
  ctx.textAlign = 'left';
  ctx.fillStyle = PAPER;
  fitFont(ctx, input.playerName, w, 96, 'normal', DISPLAY_FONT);
  ctx.fillText(input.playerName, x, 380);
  ctx.fillStyle = YELLOW;
  fitFont(ctx, `Level ${input.level} · ${input.title}`, w, 52, '800', BODY_FONT);
  ctx.fillText(`Level ${input.level} · ${input.title}`, x, 450);
  bar(ctx, x, 482, w, (input.xp - input.levelXp) / (input.nextLevelXp - input.levelXp));
  ctx.fillStyle = MUTED;
  ctx.font = `600 30px ${BODY_FONT}`;
  ctx.fillText(`${fmt(input.xp)} / ${fmt(input.nextLevelXp)} XP`, x, 540);

  // Four numbers.
  const stats: [string, string][] = [
    [fmt(input.packs), input.packs === 1 ? 'pack' : 'packs'],
    [`${input.unique}/${input.totalCards}`, 'cards'],
    [fmt(input.holos), 'holo'],
    [fmt(input.bestScore), 'best score'],
  ];
  stats.forEach(([value, label], i) => {
    const cx = x + (w / 4) * i;
    ctx.fillStyle = PAPER;
    fitFont(ctx, value, w / 4 - 20, 64, 'normal', DISPLAY_FONT);
    ctx.fillText(value, cx, 650);
    ctx.fillStyle = MUTED;
    ctx.font = `600 30px ${BODY_FONT}`;
    ctx.fillText(label, cx, 696);
  });

  // Collection score and its milestone.
  ctx.fillStyle = PAPER;
  ctx.font = `800 36px ${BODY_FONT}`;
  ctx.fillText('Collection score', x, 790);
  ctx.textAlign = 'right';
  ctx.fillStyle = YELLOW;
  ctx.font = `48px ${DISPLAY_FONT}`;
  ctx.fillText(input.milestone ?? '', x + w, 792);
  bar(ctx, x, 818, w, input.nextMilestone ? (input.points - input.milestoneFloor) / (input.nextMilestone.points - input.milestoneFloor) : 1);
  ctx.textAlign = 'left';
  ctx.fillStyle = MUTED;
  ctx.font = `600 30px ${BODY_FONT}`;
  ctx.fillText(
    `${fmt(input.points)}${input.nextMilestone ? ` / ${fmt(input.nextMilestone.points)} for ${input.nextMilestone.name}` : ''}`,
    x,
    876,
  );

  // Sets: each code with its progress; complete in white, mastered in foil.
  ctx.fillStyle = PAPER;
  ctx.font = `800 36px ${BODY_FONT}`;
  const complete = input.sets.filter((s) => s.done).length;
  const mastered = input.sets.filter((s) => s.done === 'master').length;
  ctx.fillText(`Sets · ${complete} complete${mastered ? ` · ${mastered} mastered` : ''}`, x, 966);
  const perRow = 5;
  const cellW = w / perRow;
  input.sets.forEach((set, i) => {
    const cx = x + (i % perRow) * cellW;
    const cy = 1016 + Math.floor(i / perRow) * 74;
    ctx.fillStyle = set.done ? PAPER : MUTED;
    ctx.font = `800 30px ${BODY_FONT}`;
    ctx.fillText(set.code, cx, cy);
    const codeW = ctx.measureText(set.code).width;
    ctx.font = `600 26px ${BODY_FONT}`;
    ctx.fillStyle = set.done === 'master' ? YELLOW : set.done ? PAPER : MUTED;
    ctx.fillText(set.done === 'master' ? '★' : set.done ? '✓' : `${set.have}/${set.size}`, cx + codeW + 10, cy);
    ctx.fillStyle = set.color ?? MUTED;
    ctx.fillRect(cx, cy + 12, codeW, 4);
  });

  // The best pull.
  if (input.best) {
    const top = 1016 + Math.ceil(input.sets.length / perRow) * 74 + 20;
    ctx.fillStyle = PAPER;
    ctx.font = `800 36px ${BODY_FONT}`;
    fitFont(ctx, `Best pull · ${input.best.hand} · ${fmt(input.best.score)}`, w, 36, '800', BODY_FONT);
    ctx.fillText(`Best pull · ${input.best.hand} · ${fmt(input.best.score)}`, x, top);
    const images = await Promise.all(input.best.cards.map((c) => loadImage(c.image, c.finish, input.timeoutMs)));
    const cardW = Math.min(170, (1520 - top - 60) * (687 / 1024));
    const gap = (w - cardW * 5) / 4;
    input.best.cards.forEach((card, i) => {
      drawCard(ctx, images[i], card, x + cardW / 2 + i * (cardW + gap), top + 40 + (cardW * 1024) / 687 / 2, cardW, 0);
    });
  }

  await drawLabel(ctx, {
    kind: 'Verifiable profile',
    verified: !!input.url,
    name: input.playerName,
    cert: `#${input.fingerprint}`,
    hint: input.url ? 'Scan to re-check every pack.' : 'Brainrot TCG',
    url: input.url,
  });
  return toPng(canvas);
};
