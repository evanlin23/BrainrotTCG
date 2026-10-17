/**
 * Display-name moderation. A name is signed into every proof, and proofs are permanent, so this
 * never decides what verifies: it decides whether a name is saved, published to the Hall of Fame, or
 * shown to other players. A blocked name shows as NAME_PLACEHOLDER beside the key fingerprint.
 *
 * The check folds a name the ways people dodge filters (accents, full-width, small-caps and
 * look-alike letters, leetspeak, punctuation or spaces between letters, repeated letters, camelCase
 * and xX decorations), then matches a curated list in two tiers:
 * - STRONG terms are blocked anywhere inside a word ("xXfuckXx", "hotpussy"), except inside ALLOWED
 *   words ("Pussycat", "Thorny").
 * - WHOLE terms are short words that hide inside ordinary ones ("Dickens", "cocktail", "Sussex",
 *   "Scunthorpe", "grape"), so they are blocked only as a whole word (plurals included), and not
 *   inside a few ALLOWED_PHRASES ("Moby Dick").
 * - PHRASES are blocked anywhere in the name with its spaces removed: phrases usually written as
 *   separate words, and a few common run-together names built on a WHOLE term ("bigdick").
 * Hate numbers are blocked only as a number of their own. Mild swearing (shit, damn, crap, ass, hell)
 * is allowed; slurs, sexual terms and hate are not.
 *
 * Known gaps, which a maintainer removes by hand (docs/ARCHITECTURE.md, Hall of Fame): odd spellings
 * ("sl00t"); words split into pieces longer than one letter ("Fu ck"); WHOLE terms run into other
 * words beyond the PHRASES list ("hugedick", "sexlord", "cumlord": dick, sex and cum hide inside too
 * many ordinary words to block them anywhere); phrase spellings not listed ("killurself"); a hate
 * number split up ("14 88") or written in other digits (Arabic-Indic); and terms not on the list.
 */
import { normalizeName } from './identity';

/** What other players see in place of a blocked name (always beside the key fingerprint). */
export const NAME_PLACEHOLDER = 'Player';
/** What other players see for a blank name. */
export const ANONYMOUS_NAME = 'Anonymous';

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

/** Ordinary words that contain a STRONG term (removed before matching). */
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

const STRONG_RE = new RegExp(STRONG.map(pattern).join('|'));
const PHRASE_RE = new RegExp(PHRASES.map(pattern).join('|'));
const WHOLE_RE = new RegExp(`^(?:${WHOLE.map(pattern).join('|')})(?:s+|z+)?$`);
const ALLOWED_RE = new RegExp(ALLOWED.map((w) => fold(w, true)).join('|'), 'g');
const ALLOWED_WHOLE_SET = new Set(ALLOWED_WHOLE.map((w) => fold(w, true)));
// Longest first, so "dick van dyke" goes before "van dyke".
const ALLOWED_PHRASE_RE = new RegExp(
  `(?<![a-z])(?:${[...ALLOWED_PHRASES]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.split(' ').map((w) => fold(w, true)).join('[^a-z]+'))
    .join('|')})(?![a-z])`,
  'g',
);

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
      const folded = fold(text, leet).replace(ALLOWED_PHRASE_RE, ' ');
      // Punctuation inside a word is ignored ("f.u.c.k"); spaces separate words.
      const ws = folded.split(/\s+/).map((w) => w.replace(/[^a-z]/g, '')).filter(Boolean);
      const ps = folded.split(/[^a-z]+/).filter(Boolean);
      for (const w of [...ws, ...joinSingles(ws), ...joinSingles(ps)]) words.add(w);
      for (const p of [...ps, ...ws, ...joinSingles(ws), ...joinSingles(ps)]) pieces.add(p);
      whole.push(folded.replace(/[^a-z]/g, ''));
    }
  }
  // "xXslayerXx" decorations
  for (const p of [...pieces]) {
    const bare = p.replace(/^x{2,}|x{2,}$/g, '');
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
  for (const w of words) if (STRONG_RE.test(w.replace(ALLOWED_RE, ''))) return false;
  for (const p of pieces) if (WHOLE_RE.test(p) && !ALLOWED_WHOLE_SET.has(p)) return false;
  return !whole.some((w) => PHRASE_RE.test(w));
};

/** The name to show other players: the normalized name, ANONYMOUS_NAME if blank, NAME_PLACEHOLDER if blocked. */
export const publicName = (name: string): string => {
  const clean = normalizeName(name);
  if (!clean) return ANONYMOUS_NAME;
  return isNameAllowed(clean) ? clean : NAME_PLACEHOLDER;
};
