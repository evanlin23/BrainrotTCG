import { describe, expect, it } from 'vitest';
import { ANONYMOUS_NAME, isNameAllowed, NAME_FILTER_LISTS, NAME_PLACEHOLDER, publicName, SOMEONE_NAME, visitorName } from './nameFilter';

const blocked = (names: string[]) => names.filter((name) => isNameAllowed(name));
const allowed = (names: string[]) => names.filter((name) => !isNameAllowed(name));

describe('isNameAllowed', () => {
  it('blocks slurs, sexual terms and hate', () => {
    expect(
      blocked([
        'nigger', 'nigga', 'faggot', 'fag', 'kike', 'chink', 'tranny', 'retard', 'spic', 'wetback', 'raghead',
        'Hitler', 'nazi', 'KKK', '1488', 'heil hitler', 'White Power', 'kys', 'kill your self',
        'porn', 'pornstar', 'dildo', 'penis', 'pussy', 'dick', 'cock', 'boobs', 'titties', 'sexy', 'cum', 'slut',
        'rapist', 'pedo', 'pedophile', 'molest', 'whore', 'fuck', 'motherfucker', 'cunt', 'bitch', 'asshole',
      ]),
    ).toEqual([]);
  });

  it('blocks a bad word inside a longer word or a name', () => {
    expect(blocked(['xXfuckXx', 'BigDick', 'Pussy Slayer', 'Big Boobies', 'Dicks', 'Nazis', 'Sexxx', 'Cocksucker', 'dickhead'])).toEqual([]);
    // Run together in one word, any case.
    expect(
      blocked([
        'hotpussy', 'pussylover', 'SLUTGIRL', 'cumslut', 'nazikid', 'Neonazi', 'xXboobXx', 'Lolicon',
        'bigdick', 'BIGDICK', 'bIgDiCk', 'ilovesex', 'sexyboi', 'cumdump',
      ]),
    ).toEqual([]);
  });

  it('keeps blocking a few words that only look ordinary', () => {
    expect(blocked(['Grammar Nazi', 'Niggardly', 'Pakki', 'Glasshole', 'Pussy Cats'])).toEqual([]);
  });

  it('sees through leetspeak, spacing, punctuation and repeated letters', () => {
    expect(
      blocked(['n1gg3r', 'f4gg0t', 'k1ke', 'r3tard', 'p0rn', 'd1ck', 's3x', 'b1tch', 'H1tl3r', 'N4Z1', 'B00BS', 'Pen15', 'r4pe', '$lut', 'fvck', 'cvnt', 'phuck']),
    ).toEqual([]);
    expect(blocked(['f u c k', 'c u n t', 's e x', 'N.I.G.G.E.R', 'f-u-c-k', 'f_u_c_k', 'fuuuuck', 'niiiigger', 'diiick'])).toEqual([]);
  });

  it('sees through look-alike Unicode letters and invisible characters', () => {
    expect(
      blocked([
        'Ｆｕｃｋ', // full-width
        'ⓕⓤⓒⓚ', // circled
        '𝐟𝐮𝐜𝐤', // math bold
        'ꜰᴜᴄᴋ', // small capitals
        'nіggеr', // Cyrillic і and е
        'fück', // accent
        'f​uck', // zero-width space
        'XxDickXx', // camelCase and xX decoration
      ]),
    ).toEqual([]);
  });

  it('allows ordinary words and places that contain a bad word (the Scunthorpe problem)', () => {
    expect(
      allowed([
        'Scunthorpe', 'Penistone', 'Cassandra', 'assassin', 'Dickens', 'Dickinson', 'Cockburn', 'Hancock', 'Peacock',
        'cocktail', 'Hitchcock', 'Sussex', 'Essex', 'Middlesex', 'Sexton', 'Analyst', 'Annals', 'Therapist', 'Grape',
        'Titan', 'Tit for Tat', 'Matsushita', 'Arsenal', 'Cumberland', 'Document', 'cucumber', 'Speculum', 'Spice',
        'raccoon', 'Cocoon', 'tycoon', 'Snigger', 'Niger', 'Nigeria', 'Niggle', 'Bigger', 'Digger', 'Fagin', 'Bobs',
        'Kikeriki', 'Shitzu', 'Pistachio', 'Hitachi', 'Clitheroe', 'Penal', 'Kitty', 'Pussycat', 'Wankel', 'Tranquil',
        'Rapper', 'Thorny', 'Uranus', 'Orbit Chaser', 'Epic Untamed', 'pussywillow', 'Pussyfooting', 'Milford',
        'Booboo', 'BooBoo', 'Booby Trap', 'Nazir', 'Benazir', 'Nazia', 'Nazim', 'Kanazawa', 'Hawthorny',
      ]),
    ).toEqual([]);
  });

  it('allows a few ordinary phrases and numbers holding a blocked word, but not what is added to them', () => {
    expect(
      allowed([
        'Moby Dick', 'MobyDick', 'Philip K. Dick', 'Dick Van Dyke', 'Van Dyke', 'Dick Grayson', 'Summa Cum Laude',
        'Spic and Span', 'Pussy Cat', 'Pussy Willow', 'Flabby', 'Flabby Cat', 'Blabbermouth', 'Annus Mirabilis',
        'Bonner', 'Rappe', '21488', 'Gamer21488',
      ]),
    ).toEqual([]);
    expect(
      blocked(['Moby Dick Fuck', 'MobyDickhead', 'Moby Dicks', 'Van Dyke Sex', 'Dick Grayson Sex', 'Pussy Cat Slut', 'Kid1488', 'xX1488Xx', '１４８８']),
    ).toEqual([]);
  });

  it('excuses a match only inside the allowed word or phrase itself, not a blocked word sharing its letters', () => {
    expect(
      blocked([
        'pussycatslut', 'nazirnazi', 'boobyboob', 'pornazir', 'nazirimjob', 'naziasshole', 'nazimilf', 'pussycatranny',
        'pussywillowhore', 'booboorgasm', 'milfordildo', 'Moby Dick Pic', 'Big Dick Grayson', 'Moby Dick.head', 'Hot.Pussy Cat',
      ]),
    ).toEqual([]);
    expect(allowed(['Nazir Nazia', 'Booboo Booby', 'PussycatPussyfoot', 'Moby Dick!', 'Moby-Dick', 'Moby Dick 2'])).toEqual([]);
  });

  it('blocks a blocked word wrapped around an allowed word', () => {
    expect(
      blocked(['fuNAZIRck', 'funazirck', 'fupussycatck', 'FuPussycatCk', 'cuScunthorpent', 'biMilfordtch', 'nigNazimger', 'fuNazirNazimck']),
    ).toEqual([]);
    expect(
      allowed([
        'Nazira', 'Benazir Bhutto', 'Nazim Hikmet', 'Milford Sound', 'Milfordshire', 'Pussycat Dolls', 'Thorny Rose',
        'Scunthorpe United', 'Booboo Bear', 'Boobytrap', 'Sniggering', 'Penistone FC', 'Pussywillow Lane', 'Nazir Ahmed',
      ]),
    ).toEqual([]);
  });

  it('blocks a WHOLE term wrapped around an allowed word, but not an ordinary word holding one', () => {
    expect(
      blocked(['seNAZIRx', 'diNAZIRck', 'cuNAZIRm', 'tiNAZIRts', 'coNAZIRck', 'SeNazirNazimx', 'Big diNAZIRck', 'seNAZIRxy']),
    ).toEqual([]);
    expect(
      allowed([
        'Sussex', 'Dickens', 'Cumberland', 'Titsworth', 'Dickensian', 'Sexton Nazir', 'Nazir Dickens', 'Cumberland Nazim',
        'Nazirs', 'Benazirs', 'Nazims', 'Milfords', 'Sniggers', 'Scunthorpes', 'Booboos', 'Thornycroft',
      ]),
    ).toEqual([]);
    // A cut that leaves an ALLOWED_WHOLE word ("rappe") passes.
    expect(allowed(['rapnazirpe'])).toEqual([]);
  });

  it('blocks a PHRASE wrapped around an allowed word, in one word or across words', () => {
    expect(
      blocked([
        'whitepNAZIRower', 'white NAZIR power', 'siegNAZIRheil', 'killyourNAZIRself', 'chingNAZIRchong', 'whiteBOOBYpride',
        'porchTHORNYmonkey', 'white.NAZIR.power', 'xXwhitepNAZIRowerXx',
      ]),
    ).toEqual([]);
    expect(
      allowed([
        'Nazir White', 'White Nazir', 'Benazir Whiteside', 'White Booby Trap', 'White Thorny Rose', 'Porch Thorny',
        'Ching Nazir', 'Siegfried Nazir', 'Kill Nazir', 'Nazim Powers', 'Whitney Nazir Powell', 'Siegel Nazir Heilman',
        'Chingford Nazim',
      ]),
    ).toEqual([]);
  });

  it('blocks a term sharing a letter with an allowed word inside it, but not an ordinary name doing so', () => {
    expect(
      blocked([
        'porchNAZIMonkey', 'killBOOBYourself', 'killTHORNYourself', 'killyouNAZIRself', 'whitepNAZIRide', 'p0rchN4Z1Monkey',
        'Nazirape', 'NAZIAnal', 'nazirigger', 'chiNAZIRk', 'zoopNAZIRhil',
      ]),
    ).toEqual([]);
    expect(
      allowed([
        'Nazimabad', 'Nazirabad', 'Nazira Khan', 'Boobytrap', 'Booby Island', 'Thornycroft', 'Thornyhill', 'Milford Haven',
        'Milfordian', 'Penistone Road', 'Scunthorpe Steel', 'Pussycat Dolls', 'Snigger Lane', 'Nazia Hassan', 'Nazim Hikmet',
      ]),
    ).toEqual([]);
    // Joined real names: an allowed word holding the term itself ("nazir" holds "nazi"), a shared
    // letter that doesn't touch the rest of the term, and a cut joining "p" and "h" outside "ph" terms.
    expect(
      allowed([
        'Nazir-Aziz', 'Nazir_Aziz', 'NazirAziz', 'nazir.aziz', 'BenazirAziz', 'Nazim_Azizi', 'xXNazirAzizXx', 'Nazira-Zinaida',
        'Nazima-Zidane', 'Nazia Azizi', 'MilfordLife', 'Eichhorn-Thornycroft', 'Nazia-Annais', 'Penistone-Akil', 'Hsiu-Pussycat',
        'Scunthorpe-Lutz', 'Nazira-Pes', 'Sexto-Booby', 'PhilipNazimHuckel', 'PopNazirHuckel',
      ]),
    ).toEqual([]);
    expect(blocked(['pedopNAZIRhil', 'xXNAZIRiggerXx', 'NAZIRigger-Bob'])).toEqual([]);
  });

  it('allows brainrot names, gamer tags and mild swearing', () => {
    expect(
      allowed([
        'Tung Tung Sahur', 'Bombardiro Crocodilo', 'Tralalero Tralala', 'Brr Brr Patapim', 'Skibidi', 'Rizzler',
        'Gyatt Lord', 'Ohio Final Boss', 'Fanum Tax', 'Player 1', 'Gamer420', 'R2D2', '1337 h4x0r', 'Sk8r Boi',
        'xXSlayerXx', 'Sigma Toaster 69', 'Unhinged Raccoon 42', 'Shit Happens', 'Damn Son', 'Crap Bag', 'Glass Cannon',
      ]),
    ).toEqual([]);
  });

  it('allows a blank name (it shows as Anonymous)', () => {
    expect(isNameAllowed('')).toBe(true);
  });
});

/**
 * Names generated from the filter's own lists: every STRONG, WHOLE and PHRASES term with every ALLOWED
 * word inserted at every position (before the first letter through after the last), and also at every
 * position where the allowed word supplies a letter of the term: its first letter ("NAZIRigger" for
 * "nigger") or its last ("porchNAZIMonkey" for "porchmonkey"). That is every term x allowed word x
 * position, with no sampling. Each name gets one spelling, rotating with the term, allowed word and
 * position, so every term and every allowed word is seen in every spelling: the allowed word as is,
 * upper case or capitalized; dots around it; leetspeak (digits, allowed word upper case); Cyrillic
 * look-alikes; and, for PHRASES only, spaces around it. A shared-letter name skips the dots and
 * spaces, as the filter reads a shared letter only where it touches the rest of the term.
 *
 * Left out, as the filter excuses them (see strongNotExcused): a term the allowed word holds itself, read
 * at the letter they share ("nazirazi", like "NazirAziz"). Left out as "Known gaps" in nameFilter.ts:
 * a STRONG or WHOLE term split by spaces ("fu nazir ck", like "Fu ck"), and a name where the inserted
 * allowed word overlaps another one ("nazimilford", "booBOOBYb"). No randomness, so the same names run every time.
 */
const generatedNames = () => {
  const { strong, whole, phrases, allowed: allowedWords } = NAME_FILTER_LISTS;
  const leet: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' };
  const lookAlike: Record<string, string> = { a: 'а', c: 'с', e: 'е', i: 'і', k: 'к', o: 'о', p: 'р', x: 'х', y: 'у' };
  const swap = (text: string, map: Record<string, string>) => Array.from(text, (c) => map[c] ?? c).join('');
  type Spelling = (before: string, word: string, after: string) => string;
  const dotted: Spelling = (b, w, a) => [b, w, a].filter(Boolean).join('.');
  const spellings: Spelling[] = [
    (b, w, a) => b + w + a,
    (b, w, a) => b + w.toUpperCase() + a,
    (b, w, a) => b + w[0].toUpperCase() + w.slice(1) + a,
    dotted,
    (b, w, a) => swap(b, leet) + swap(w, leet).toUpperCase() + swap(a, leet),
    (b, w, a) => swap(b + w + a, lookAlike),
  ];
  const spaced: Spelling = (b, w, a) => [b, w, a].filter(Boolean).join(' ');
  // Where another allowed word overlaps the inserted one at [start, end) in the plain name.
  const overlapsAnother = (name: string, start: number, end: number) =>
    allowedWords.some((other) => {
      for (let i = name.indexOf(other); i >= 0; i = name.indexOf(other, i + 1)) {
        if (i < end && i + other.length > start && !(i === start && other.length === end - start)) return true;
      }
      return false;
    });
  const names: string[] = [];
  const covered = new Set<string>();
  const terms = [...strong, ...whole, ...phrases].map((term) => ({ term, spellings: phrases.includes(term) ? [...spellings, spaced] : spellings }));
  terms.forEach(({ term, spellings: forTerm }, t) => {
    allowedWords.forEach((word, w) => {
      // [before, after] around the allowed word: inserted, or replacing a letter it shares with the term.
      const cuts: [string, string, boolean][] = [];
      for (let i = 0; i <= term.length; i++) cuts.push([term.slice(0, i), term.slice(i), false]);
      // Not where the term starts at the allowed word's first letter, or ends at its last, and the
      // allowed word holds the term itself ("nazirazi", "boobyoob"): the term read there is the one
      // inside the allowed word, which is excused, as in "NazirAziz".
      const holds = word.includes(term);
      for (let i = 0; i < term.length; i++) {
        if (term[i] === word[0] && !(i === 0 && holds)) cuts.push([term.slice(0, i), term.slice(i + 1), true]);
        if (term[i] === word[word.length - 1] && !(i === term.length - 1 && holds)) cuts.push([term.slice(0, i), term.slice(i + 1), true]);
      }
      cuts.forEach(([before, after, shared], c) => {
        if (overlapsAnother(before + word + after, before.length, before.length + word.length)) return;
        // A shared letter is read with the rest of the term only where they touch, so a shared-letter
        // name skips the dotted and spaced spellings ("nazia.nal", "porch nazim onkey").
        const pick = forTerm.map((_, s) => s).filter((s) => !shared || (forTerm[s] !== dotted && forTerm[s] !== spaced));
        const s = pick[(t + w + c) % pick.length];
        names.push(forTerm[s](before, word, after));
        covered.add(`${term} ${word}`).add(`${term} #${s}`).add(`${word} #${s}`);
      });
    });
  });
  const expected = [
    ...terms.flatMap(({ term, spellings: forTerm }) => [
      ...allowedWords.map((word) => `${term} ${word}`),
      ...forTerm.map((_, s) => `${term} #${s}`),
    ]),
    ...allowedWords.flatMap((word) => [...spellings, spaced].map((_, s) => `${word} #${s}`)),
  ];
  return { names, covered, expected };
};

describe('isNameAllowed on names generated from its lists', () => {
  const generated = generatedNames();

  it('covers every term with every allowed word, and each of them in every spelling', () => {
    expect(generated.expected.filter((key) => !generated.covered.has(key))).toEqual([]);
  });

  it('blocks every term with an allowed word inserted or sharing a letter, in every spelling', () => {
    expect(blocked(generated.names)).toEqual([]);
  });
});

describe('publicName', () => {
  it('shows an allowed name normalized', () => {
    expect(publicName('  Pack   Ripper ')).toBe('Pack Ripper');
  });

  it('shows the placeholder for a blocked name and Anonymous for a blank one', () => {
    expect(publicName('xXfuckXx')).toBe(NAME_PLACEHOLDER);
    expect(publicName('Ｆｕｃｋ')).toBe(NAME_PLACEHOLDER);
    expect(publicName('   ')).toBe(ANONYMOUS_NAME);
    expect(NAME_PLACEHOLDER).toBe('Player');
  });
});

describe('visitorName', () => {
  it('shows an allowed name as publicName does', () => {
    expect(visitorName('  Pack   Ripper ')).toBe('Pack Ripper');
  });

  it('keeps a chosen name that matches a fallback label, normalized', () => {
    expect(visitorName('Player')).toBe('Player');
    expect(visitorName('Anonymous')).toBe('Anonymous');
    expect(visitorName('  Player ')).toBe('Player');
    expect(visitorName('Player')).toBe(publicName('Player'));
  });

  it('reads Someone for a blank or blocked name, never Anonymous or Player', () => {
    for (const name of ['', '   ', 'xXfuckXx', 'Ｆｕｃｋ']) expect(visitorName(name)).toBe(SOMEONE_NAME);
    expect(SOMEONE_NAME).toBe('Someone');
  });
});
