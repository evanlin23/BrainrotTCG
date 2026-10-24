/**
 * Display-name moderation. A name is signed into every proof, and proofs are permanent, so this
 * never decides what verifies: it decides whether a name is saved, published to the Hall of Fame, or
 * shown to other players. On shared pages (pulls, profiles, the Hall of Fame) `visitorName` shows a
 * blank or blocked name as SOMEONE_NAME beside the key fingerprint; `publicName` (ANONYMOUS_NAME,
 * NAME_PLACEHOLDER) keeps its other uses, such as Hall of Fame issue titles.
 *
 * The check folds a name the ways people dodge filters (accents, full-width, small-caps and
 * look-alike letters, leetspeak, punctuation or spaces between letters, repeated letters, camelCase
 * and xX decorations), then matches a curated list in two tiers:
 * - STRONG terms are blocked anywhere inside a word ("xXfuckXx", "hotpussy"), except wholly inside
 *   one ALLOWED word ("Pussycat", "Thorny", but not "Pornazir").
 * - WHOLE terms are short words that hide inside ordinary ones ("Dickens", "cocktail", "Sussex",
 *   "Scunthorpe", "grape"), so they are blocked only as a whole word (plurals included), and not
 *   inside a few ALLOWED_PHRASES ("Moby Dick", but not "Moby Dick.head").
 * - PHRASES are blocked anywhere in the name with its spaces removed: phrases usually written as
 *   separate words, and a few common run-together names built on a WHOLE term ("bigdick").
 * - A word or name holding an ALLOWED word is also checked with its ALLOWED words cut out (again
 *   until none is left), against STRONG, WHOLE and PHRASES, so wrapping a term around one doesn't
 *   hide it: "fuNAZIRck" reads "fuck", "seNAZIRx" reads "sex" and "white NAZIR power" reads
 *   "whitepower". A WHOLE cut that is an ALLOWED_WHOLE word passes ("rapNAZIRpe" reads "rappe").
 *   Each cut is also made keeping the allowed word's first or last letter, for a term that shares
 *   it: "porchNAZIMonkey" reads "porchmonkey", "NAZIAnal" reads "anal". A shared letter is read with
 *   the rest of the term only where they touch ("Nazia-Annais" passes), and not for a term the
 *   allowed word holds itself ("NazirAziz" passes: its "nazi" is the one in "nazir").
 * Hate numbers are blocked only as a number of their own. Mild swearing (shit, damn, crap, ass, hell)
 * is allowed; slurs, sexual terms and hate are not.
 *
 * Known gaps, which a maintainer removes by hand (docs/ARCHITECTURE.md, Hall of Fame): odd spellings
 * ("sl00t"); words split into pieces longer than one letter ("Fu ck", also around an allowed word:
 * "fu Nazir ck"); two allowed words that overlap, when only cutting the second one would leave the
 * term ("nazimilford", "booBOOBYb"); WHOLE terms run into other words beyond the PHRASES list
 * ("hugedick", "sexlord", "cumlord": dick, sex and cum hide inside too many ordinary words to block
 * them anywhere); phrase spellings not listed ("killurself"); a shared letter split from the rest
 * of the term by a space or punctuation ("porch nazim onkey"); a hate number split up ("14 88") or
 * written in other digits (Arabic-Indic); and terms not on the list. The other way, an ordinary name
 * run into an allowed word in camelCase is blocked when the shared letter starts a term with it
 * ("NaziaNail" reads "anal", "NazirUde" "nude", "PenistoneOrnella" "porn"), as "NAZIAnal" is.
 */
import { normalizeName } from './identity';

/** What other players see in place of a blocked name (always beside the key fingerprint). */
export const NAME_PLACEHOLDER = 'Player';
/** What other players see for a blank name. */
export const ANONYMOUS_NAME = 'Anonymous';
/** What a visitor reading someone else's pull, profile or ranking row sees for a blank or blocked name. */
export const SOMEONE_NAME = 'Someone';

/** Words blocked anywhere inside a word. */
const STRONG = [
  // slurs and hate
  'nigger', 'nigga', 'niqqer', 'niqqa', 'faggot', 'tranny', 'shemale', 'wetback', 'raghead', 'towelhead',
  'jigaboo', 'zipperhead', 'golliwog', 'mongoloid', 'hitler', 'nazi',
  // sexual
  'porn', 'hentai', 'vagina', 'penis', 'pussy', 'slut', 'milf', 'boob', 'horny', 'jizz', 'dildo', 'blowjob',
  'handjob', 'rimjob', 'orgasm', 'cumshot', 'creampie', 'gangbang', 'deepthroat', 'masturbat', 'fellatio',
  'cunnilingus', 'bdsm', 'bestiality', 'zoophil', 'pedophil', 'paedophil', 'lolicon', 'molest', 'whore',
  'cocksucker',
  // abuse
  'fuck', 'cunt', 'bitch', 'asshole', 'dickhead',
];

/** Blocked anywhere in the name with its spaces removed. */
const PHRASES = [
  // usually written as separate words
  'killyourself', 'siegheil', 'heilhitler', 'whitepower', 'whitepride', 'chingchong', 'porchmonkey',
  // common run-together names built on a WHOLE term (see "Known gaps" above)
  'bigdick', 'suckdick', 'dickpic', 'ilovesex', 'hotsex', 'sextoy', 'sexyboi', 'sexyboy', 'sexygirl',
  'cumslut', 'cumdump',
];

/** Words blocked only on their own (with an optional plural s or z). */
const WHOLE = [
  // slurs and hate
  'fag', 'kike', 'chink', 'chinky', 'retard', 'retarded', 'tard', 'spic', 'spick', 'beaner', 'gook', 'coon',
  'paki', 'dyke', 'spaz', 'kkk', 'kys',
  // sexual
  'sex', 'sexy', 'dick', 'cock', 'clit', 'tits', 'titty', 'titties', 'cum', 'anal', 'anus', 'orgy', 'rape',
  'raped', 'rapist', 'pedo', 'incest', 'boner', 'semen', 'nude', 'thot', 'skank',
  // abuse
  'fuk', 'fuq', 'fck', 'fcuk', 'twat', 'wank', 'wanker', 'wanking',
];

/** Ordinary words that contain a STRONG term (a match wholly inside one is ignored). */
const ALLOWED = [
  'scunthorpe', 'snigger', 'pussycat', 'pussywillow', 'pussyfoot', 'penistone', 'milford', 'booboo', 'booby',
  'thorny', 'nazir', 'nazia', 'nazim',
];

/** Ordinary words that a WHOLE pattern would catch (its letters may repeat). */
const ALLOWED_WHOLE = ['annal', 'annals', 'annus', 'bonner', 'rappe'];

/** Ordinary phrases holding a blocked word, removed before matching ("Moby Dick", not "Big Dick"). */
const ALLOWED_PHRASES = [
  'moby dick', 'philip k dick', 'dick van dyke', 'van dyke', 'dick grayson', 'cum laude', 'spic and span',
  'pussy cat', 'pussy willow',
];

/** The blocked terms and allowed words, for tests that generate names from them. */
export const NAME_FILTER_LISTS: {
  readonly strong: readonly string[];
  readonly whole: readonly string[];
  readonly phrases: readonly string[];
  readonly allowed: readonly string[];
} = { strong: STRONG, whole: WHOLE, phrases: PHRASES, allowed: ALLOWED };

/** Hate numbers, blocked only as a number of their own ("Kid1488", not "21488" or "Flabby" read as leetspeak). */
const NUMBER_RE = /(?<!\d)(?:1488)(?!\d)/;

/** Letters that look alike or stand in for each other, after lowercasing; one key per character. */
const LETTERS: Record<string, string> = {
  // Cyrillic and Greek look-alikes
  а: 'a', б: 'b', в: 'b', г: 'r', д: 'd', е: 'e', ё: 'e', и: 'u', й: 'u', к: 'k', м: 'm', н: 'h', о: 'o',
  п: 'n', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ш: 'w', ь: 'b', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd',
  ԛ: 'q', ԝ: 'w', α: 'a', β: 'b', γ: 'y', ε: 'e', ζ: 'z', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v',
  ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  // small capitals and other Latin letters NFKC leaves alone
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm',
  ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z', ı: 'i',
  ø: 'o', đ: 'd', ł: 'l', ħ: 'h', ß: 'ss', æ: 'ae', œ: 'oe',
  // stand-ins: l and 1 and i, v and u, are each folded to one letter
  l: 'i', v: 'u',
};

/** Digits and symbols used as letters (only in the leetspeak reading of a name). */
const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '!': 'i', '|': 'i', '¡': 'i', '3': 'e', '€': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's',
  '7': 't', '+': 't', '8': 'b', '6': 'g', '9': 'g', '(': 'c', '¢': 'c',
};

/** Unicode compatibility forms (full-width, circled, math letters) to plain ones, without accents or invisibles. */
const plain = (text: string) => text.normalize('NFKC').normalize('NFD').replace(/[\p{M}\p{C}]/gu, '');

/** Splits camelCase ("BigWord" -> "Big Word") before lowercasing loses it. */
const splitCamel = (text: string) => text.replace(/(?<=[\p{Ll}\p{Nd}])(?=\p{Lu})/gu, ' ');

const fold = (text: string, leet: boolean) =>
  Array.from(text.toLowerCase(), (c) => LETTERS[c] ?? (leet ? LEET[c] : undefined) ?? c)
    .join('')
    .replace(/ph/g, 'f');

/** A regex for a folded term: each letter may repeat ("fuuuck"), and a doubled one needs at least two ("boobs", not "bobs"). */
const pattern = (term: string) =>
  (fold(term, true).match(/(.)\1*/g) ?? []).map((run) => (run.length === 1 ? `${run}+` : `${run[0]}{${run.length},}`)).join('');

/** A STRONG term list compiled for matching: any of them, the next match of any, and each from a position. */
const strongTerms = (terms: readonly string[]) => ({
  terms,
  any: new RegExp(terms.map(pattern).join('|')),
  next: new RegExp(terms.map(pattern).join('|'), 'g'),
  // A term's letter runs each differ from the next, so its greedy match from a position is the longest one it has.
  each: terms.map((term) => new RegExp(pattern(term), 'y')),
});
const STRONG_TERMS = strongTerms(STRONG);
// The terms spelled with "ph", for a cut that joins "p" and "h" ("zoopNAZIRhil" reads "zoophil").
const PH_TERMS = strongTerms(STRONG.filter((term) => term.includes('ph')));
const PHRASE_RE = new RegExp(PHRASES.map(pattern).join('|'));
const WHOLE_RE = new RegExp(`^(?:${WHOLE.map(pattern).join('|')})(?:s+|z+)?$`);
const ALLOWED_FOLDED = ALLOWED.map((w) => fold(w, true));
// The STRONG terms each allowed word holds ("nazir" holds "nazi", "thorny" holds "horny").
const ALLOWED_HOLDS = new Map(ALLOWED_FOLDED.map((a) => [a, new Set(STRONG.filter((term) => new RegExp(pattern(term)).test(a)))]));
// Longest first, so the longer of two overlapping allowed words is cut ("booboo" before "booby").
const ALLOWED_LONGEST = [...ALLOWED_FOLDED].sort((a, b) => b.length - a.length);
type Keep = 'none' | 'first' | 'last';
// An allowed word is cut out whole, or keeping its first or its last letter for a term that shares
// it ("porchNAZIMonkey" reads "porchmonkey", "NAZIAnal" reads "anal"). One group per allowed word.
const ALLOWED_CUT_WAYS = (
  [
    ['none', (a: string) => `(${a})`],
    ['first', (a: string) => `(?<=${a[0]})(${a.slice(1)})`],
    ['last', (a: string) => `(${a.slice(0, -1)})(?=${a[a.length - 1]})`],
  ] as const
).map(([keep, cut]) => ({ keep: keep as Keep, re: new RegExp(ALLOWED_LONGEST.map(cut).join('|'), 'g') }));
const ALLOWED_WHOLE_SET = new Set(ALLOWED_WHOLE.map((w) => fold(w, true)));
// Longest first, so "dick van dyke" goes before "van dyke". It must start and end a word (letters
// after punctuation belong to the same word), so "Moby Dick.head" keeps its "dickhead".
const ALLOWED_PHRASE_RE = new RegExp(
  `(?<![a-z]\\S*)(?:${[...ALLOWED_PHRASES]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.split(' ').map((w) => fold(w, true)).join('[^a-z]+'))
    .join('|')})(?!\\S*[a-z])`,
  'g',
);

/**
 * A word with allowed words cut out. Where the cut kept an allowed word's first or last letter (as
 * `keep` says), `kept.get(i)` is the allowed word the letter at i stands for.
 */
type Cut = { text: string; keep: Keep; kept: Map<number, string> };

/** A word as `readings` gives it ("-" for each run of non-letters) without its non-letters. */
const letters = (word: string) => word.replace(/-/g, '');

/**
 * The word with its ALLOWED words cut out, again until none is left ("seNAZIRx" -> "sex"), in each
 * way of cutting (whole, or keeping a shared first or last letter); empty if it holds none. The word
 * shows each run of non-letters as "-". A whole cut drops them ("fu.NAZIR.ck" reads "fuck"), but a
 * cut keeping a letter doesn't: a shared letter is read with the rest of the term only where they
 * touch, so "porchNAZIMonkey" reads "porchmonkey" and "Nazia-Annais" doesn't read "aannais".
 */
const allowedCuts = (word: string): Cut[] => {
  const cuts: Cut[] = [];
  for (const { keep, re } of ALLOWED_CUT_WAYS) {
    let text = keep === 'none' ? letters(word) : word;
    let kept = new Map<number, string>();
    // Each cut is shorter than the last, so each way ends within the word's length.
    for (;;) {
      let next = '';
      const nextKept = new Map<number, string>();
      // Copies text[from, to), giving its first letter the allowed word a keep-last cut kept it for.
      let carry: string | undefined;
      const copy = (from: number, to: number) => {
        if (from >= to) return;
        for (const [at, a] of kept) if (at >= from && at < to) nextKept.set(next.length + at - from, a);
        if (carry) nextKept.set(next.length, carry);
        next += text.slice(from, to);
      };
      let i = 0;
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const a = ALLOWED_LONGEST[m.findIndex((group, g) => g > 0 && group !== undefined) - 1];
        copy(i, m.index);
        // A keep-first cut keeps the letter before the match, unless an earlier match took it.
        if (keep === 'first' && i < m.index) nextKept.set(next.length - 1, a);
        carry = keep === 'last' ? a : undefined;
        i = m.index + m[0].length;
      }
      if (!i) break;
      copy(i, text.length);
      text = next;
      kept = nextKept;
      cuts.push({ text, keep, kept });
    }
  }
  return cuts;
};

/**
 * Whether a STRONG term matches in the word other than wholly inside one ALLOWED word ("Nazir", not
 * "Pornazir"). In a cut, a match is also excused when it starts at a kept first letter, or ends at a
 * kept last letter, of an allowed word that holds that term itself: "NazirAziz" cuts to "naziz", but
 * its "nazi" is the one in "nazir"; "NAZIRigger" still reads "nigger".
 */
const strongNotExcused = (word: string, cut?: Cut, { terms, any, next, each } = STRONG_TERMS): boolean => {
  if (!any.test(word)) return false;
  const spans: [number, number][] = [];
  for (const a of ALLOWED_FOLDED) for (let i = word.indexOf(a); i >= 0; i = word.indexOf(a, i + 1)) spans.push([i, i + a.length]);
  if (!spans.length && !cut?.kept.size) return true;
  // Each position where some term matches, in order.
  for (let start = 0; ; start++) {
    next.lastIndex = start;
    const match = next.exec(word);
    if (!match) break;
    start = match.index;
    // A match from here is excused only if it ends within an allowed word that covers its start.
    let end = start;
    for (const [a, b] of spans) if (a <= start && b > end) end = b;
    for (const [t, re] of each.entries()) {
      re.lastIndex = start;
      if (!re.test(word) || re.lastIndex <= end) continue;
      const keptBy = cut?.kept.get(cut.keep === 'first' ? start : re.lastIndex - 1);
      if (keptBy === undefined || !ALLOWED_HOLDS.get(keptBy)?.has(terms[t])) return true;
    }
  }
  return false;
};

/**
 * Whether a STRONG term matches in a word other than wholly inside one ALLOWED word, or around one:
 * the word with its allowed words cut out is checked again, so "fuNAZIRck" reads "fuck". A cut that
 * joins "p" and "h" also reads "f", as the fold does, for the terms spelled with "ph" only:
 * "zoopNAZIRhil" reads "zoophil", "PopNazirHuckel" doesn't read "fuck".
 */
const strongOutsideAllowed = (word: string, cuts: readonly Cut[]): boolean =>
  strongNotExcused(letters(word)) ||
  cuts.some(
    (cut) => strongNotExcused(cut.text, cut) || (cut.text.includes('ph') && strongNotExcused(cut.text.replace(/ph/g, 'f'), undefined, PH_TERMS)),
  );

/** Whether a piece is a WHOLE term on its own (with an optional plural), other than an ALLOWED_WHOLE word. */
const wholeTerm = (piece: string) => WHOLE_RE.test(piece) && !ALLOWED_WHOLE_SET.has(piece);

/** Runs of two or more one-letter tokens joined ("f u c k" -> "fuck"). */
const joinSingles = (tokens: readonly string[]) => {
  const runs: string[] = [];
  let run = '';
  for (const t of [...tokens, '']) {
    if (t.length === 1) run += t;
    else {
      if (run.length > 1) runs.push(run);
      run = '';
    }
  }
  return runs;
};

/** The words of each reading of a name, and the pieces between any non-letters, for matching. */
const readings = (name: string) => {
  const base = plain(name);
  const words = new Set<string>();
  const pieces = new Set<string>();
  const whole: string[] = [];
  for (const text of [base, splitCamel(base)]) {
    for (const leet of [true, false]) {
      const folded = fold(text, leet);
      const kept = folded.replace(ALLOWED_PHRASE_RE, ' ');
      // Punctuation inside a word is ignored ("f.u.c.k"); spaces separate words. A word keeps each run
      // of non-letters as "-" for allowedCuts, and drops it for everything else.
      const ws = kept.split(/\s+/).map((w) => w.replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')).filter(Boolean);
      const ps = kept.split(/[^a-z]+/).filter(Boolean);
      for (const w of [...ws, ...joinSingles(ws), ...joinSingles(ps)]) words.add(w);
      for (const p of [...ps, ...ws, ...joinSingles(ws), ...joinSingles(ps)]) pieces.add(p);
      // No allowed phrase holds a PHRASE, so allowed phrases stay in: "Moby Dick Pic" still reads "dickpic".
      whole.push(folded.replace(/[^a-z]+/g, '-').replace(/^-|-$/g, ''));
    }
  }
  // "xXslayerXx" decorations
  for (const p of [...pieces]) {
    const bare = p.replace(/^x{2,}-?|-?x{2,}$/g, '');
    if (bare) pieces.add(bare);
  }
  return { words, pieces, whole };
};

/**
 * Whether a display name may be saved, published or shown to other players. Blank names pass (they
 * show as ANONYMOUS_NAME). Only for display and publishing: proof verification never calls it.
 */
export const isNameAllowed = (name: string): boolean => {
  if (NUMBER_RE.test(plain(name))) return false;
  const { words, pieces, whole } = readings(name);
  // Most words are pieces too, so each is cut once.
  const cutsOf = new Map<string, Cut[]>();
  const cuts = (w: string) => {
    let c = cutsOf.get(w);
    if (!c) cutsOf.set(w, (c = allowedCuts(w)));
    return c;
  };
  for (const w of words) if (strongOutsideAllowed(w, cuts(w))) return false;
  for (const p of pieces) {
    if (wholeTerm(letters(p)) || cuts(p).some(({ text }) => wholeTerm(text) || PHRASE_RE.test(text))) return false;
  }
  // The whole name runs its words together, so its cuts also take out an allowed word between them ("white NAZIR power").
  return !whole.some((w) => PHRASE_RE.test(letters(w)) || cuts(w).some(({ text }) => PHRASE_RE.test(text)));
};

/** The name to show other players: the normalized name, ANONYMOUS_NAME if blank, NAME_PLACEHOLDER if blocked. */
export const publicName = (name: string): string => {
  const clean = normalizeName(name);
  if (!clean) return ANONYMOUS_NAME;
  return isNameAllowed(clean) ? clean : NAME_PLACEHOLDER;
};

/**
 * The name a visitor sees for another player on shared pages (pulls, profiles, the Hall of Fame): the
 * normalized name as publicName shows it, except that a blank or blocked one reads SOMEONE_NAME. A
 * player who chose "Player" or "Anonymous" keeps it. Display only: proof verification never calls it.
 */
export const visitorName = (name: string): string => {
  const clean = normalizeName(name);
  return clean && isNameAllowed(clean) ? clean : SOMEONE_NAME;
};
