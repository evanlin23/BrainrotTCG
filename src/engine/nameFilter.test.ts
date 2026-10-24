import { describe, expect, it } from 'vitest';
import { ANONYMOUS_NAME, isNameAllowed, NAME_PLACEHOLDER, publicName, SOMEONE_NAME, visitorName } from './nameFilter';

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
        'Nazirs', 'Benazirs', 'Nazims', 'Milfords', 'Sniggers', 'Scunthorpes', 'Booboos', 'Thornycroft', 'rapnazirpe',
      ]),
    ).toEqual([]);
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
