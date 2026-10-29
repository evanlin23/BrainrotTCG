# Brainrot TCG pull proofs: specification (v1)

This is the normative spec for verifying a Brainrot TCG pull. Anyone can implement it; nothing here
depends on the game's code. `spec/vectors.json` has test vectors, and `spec/verify_pull.py` is a
second, independent implementation written from this document. CI checks it against the vectors
and against the TypeScript engine (`src/engine/`).

The keywords MUST, MUST NOT and SHOULD are used as in RFC 2119.

## 1. Overview

```
proof link  ─► decode (strict) ─► check name ─► check key ─► check Ed25519 signature ─► look up set@version
                                                                              │
cards + score ◄─ generate pack ◄─ sfc32 PRNG ◄─ SHA-256 seed ◄─ Argon2id ticket(set, key, nonce)
```

A proof never contains cards. The verifier derives them, so a proof can't claim cards it didn't pull.

## 2. Primitives

- **UTF-8**: strings are encoded as UTF-8. A decoder MUST reject invalid UTF-8 (overlong forms,
  surrogates, code points above U+10FFFF, truncated sequences) and MUST NOT strip a leading byte order
  mark (U+FEFF is kept as a character).
- **Hex**: lowercase, two digits per byte.
- **base64url**: RFC 4648 §5 alphabet `A–Z a–z 0–9 - _`, **no padding**. A decoder MUST reject
  `=`, any other character, a length ≡ 1 (mod 4), and **non-canonical input**: the unused low bits of
  the last character MUST be zero. (Equivalently: re-encoding the decoded bytes gives the same text.)
  A verifier MAY ignore ASCII space, tab, CR and LF before and after the whole text (what a paste
  tends to add) and MUST treat any other character there, including other Unicode whitespace and
  U+FEFF, as part of the text (so it fails `decode`).
- **varint**: unsigned LEB128, 7 bits per byte, least significant group first, high bit set on every
  byte but the last. Values are 0 … 2⁵³−1 (at most 8 bytes). The encoding MUST be minimal: no
  trailing `0x80`-continued zero groups (the last byte of a multi-byte varint is never `0x00`).
- **u16be**: two bytes, big-endian.

## 3. Sets

A set is a JSON document (`src/content/sets/<id>/set.json`; older versions are kept as
`set.v<N>.json`). The fields used for verification:

| Field | Meaning |
| --- | --- |
| `id`, `version` | the set key is `` `${id}@${version}` ``, e.g. `right-now@1` |
| `packSize` | cards per pack (1 … 15) |
| `odds` | integer weight per rarity, summing to **10000** |
| `holoOdds` | chance of holo per card, out of 10000 |
| `modifiers` | optional. `1` = every card also rolls a finish and a misprint with modifier table 1 (section 5.4). Absent = no modifiers. Any other value is invalid. |
| `cards` | ordered list of `{ id, rarity }`. **Order matters.** Every rarity with a non-zero weight has at least one card. |

Rarities, rarest first (this order is normative): `BRAINROT, LEGENDARY, EPIC, RARE, UNCOMMON, COMMON`.

A released `set@version` never changes (the repository's `src/content/sets.lock.json` guards this;
take set files from a commit you trust). Archived sets (`archivedAt`) still verify. External fan tools
and verifiers can also fetch canonical set versions from the static API at `/api/sets.json` (see `docs/API.md`).

## 4. Ticket (proof of work)

```
ticket = Argon2id(
  password = UTF-8("brainrot-tcg/ticket/v1|" + setKey + "|" + hex(publicKey) + "|" + decimal(nonce)),
  salt     = UTF-8("brainrot-tcg/ticket-salt/v1"),
  memory   = 32768 KiB, iterations = 2, parallelism = 1, tag length = 32 bytes,
  version  = 0x13, no secret, no associated data)
```

`decimal(nonce)` has no leading zeros, sign or separators.

## 5. Pack generation

1. `seed = SHA-256(UTF-8("brainrot-tcg/pack/v1") || ticket)`.
2. **sfc32 PRNG.** All arithmetic is on unsigned 32-bit integers, wrapping mod 2³².
   `a, b, c, d` are the little-endian u32s at seed bytes 0–3, 4–7, 8–11, 12–15.
   ```
   next():
     t = a + b + d
     d = d + 1
     a = b XOR (b >> 9)
     b = c + (c << 3)
     c = (c << 21) | (c >> 11)        # rotate left by 21
     c = c + t
     return t
   ```
   Call `next()` 15 times and discard the results. Then `int(n) = floor(next() × n / 2³²)`
   (exact integer arithmetic). (The `rng` test vectors list the outputs after these 15.)
3. For each slot `0 … packSize−1`, in order:
   1. `roll = int(10000)`. Walk the rarities rarest first, adding each rarity's weight to a running
      total; the slot's rarity is the first whose running total is greater than `roll`.
   2. `pool` = the set's cards of that rarity, in set order. `card = pool[int(len(pool))]`.
   3. `holo = int(10000) < holoOdds`.
   4. Only if the set has `modifiers` (section 5.4): two more draws, `finish` then `misprint`.
      Without `modifiers` a slot is exactly the three draws above.

### 5.4 Modifiers

A set version with `"modifiers": 1` gives every card two more properties, drawn right after its holo
draw, in this order:

1. **Finish.** `roll = int(10000)`. Walk the finishes rarest first, adding each weight to a running
   total; the finish is the first whose running total is greater than `roll`, or none if no total is.

   | Finish (rarest first, normative order) | `DIAMOND` | `PLATINUM` | `GOLD` | `SILVER` | none |
   | --- | --- | --- | --- | --- | --- |
   | Weight (out of 10000) | 10 | 50 | 250 | 1000 | the remaining 8690 |

2. **Misprint.** `misprint = int(10000) < 50`.

This is modifier table 1. It never changes; different odds would be table 2. Older set versions
don't opt in, so every pack that verified before modifiers existed is unchanged.

## 6. Proof format

A proof is base64url (section 2) of these bytes:

| Bytes | Field |
| --- | --- |
| 1 | proof version, `0x01` |
| 1 + n | set id: length byte `n` (1 … 64), then UTF-8 |
| 2 | set version, u16be |
| 32 | player public key (Ed25519) |
| varint | nonce (ticket number) |
| 1 + n | display name: length byte `n` (0 … 255), then UTF-8 |
| 64 | Ed25519 signature |

The signed message is `UTF-8("brainrot-tcg/proof/v1") || <every byte before the signature>`.

Share links look like `https://…/#/pull/<proof>`.

## 7. Verification

A verifier MUST apply these checks **in this order** and reject the proof at the first one that fails,
reporting that rule (the `rule` of each invalid test vector):

1. **`decode`.** base64url, varint and UTF-8 are canonical (section 2), the version byte is 1, the
   set id is 1 … 64 bytes, every field is present (the input doesn't run out early), and there are no
   bytes after the signature.
2. **`name`.** The name (it's signed, so these rules use only fixed lists, never Unicode tables that
   change between versions):
   - at most 24 code points;
   - no control characters: U+0000–U+001F, U+007F–U+009F;
   - none of these invisible or bidirectional format code points (the list is complete): U+00AD,
     U+061C, U+180E, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+206F, U+FEFF,
     U+FFF9–U+FFFB, U+E0001, U+E0020–U+E007F. (This includes the zero-width joiner and tag
     characters, so the game strips them from names before signing: a family or flag emoji becomes
     its separate parts.)
   - U+0020 is the only space: none of U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F,
     U+3000;
   - no leading or trailing U+0020, and never two in a row.
3. **`publicKey`.** The key decodes as a point per RFC 8032 §5.1.3 (y < 2²⁵⁵−19, the point is on the
   curve, and not x = 0 with the sign bit set), and the point has **prime order L**: `[L]A` is the
   identity and A is not the identity. (This rules out the eight small-order points, for which anyone
   can forge signatures, and keys with a hidden small-order component.)
4. **`signature`.** With `R` = the signature's first 32 bytes and `S` = its last 32 bytes as a
   little-endian integer: `S < L`; `k` = SHA-512(R || A || message) read as a little-endian integer,
   mod L (A as the 32 key bytes, message as in section 6); and the **cofactorless** equation holds: the encoding of `[S]B − [k]A` is
   byte-for-byte equal to `R`. Use exactly this check: a cofactored verifier (`[8][S]B = [8]R + [8][k]A`)
   accepts signatures this rejects. `R` is not otherwise checked.
5. **`set`.** `set@version` exists.

Here `L = 2²⁵² + 27742317777372353535851937790883648493` and `B` is the Ed25519 base point.

Then derive the pack (sections 4–5) and score it (section 8).

**Same pull.** Two valid proofs with the same set key, public key and nonce are the same pull, even if
their names or signatures differ (an owner can sign many times). Its **pull id** is
`` `${setKey}/${hex(publicKey)}/${decimal(nonce)}` ``. Leaderboards MUST deduplicate on the pull id.

## 8. Score

- Card points: `COMMON 10, UNCOMMON 20, RARE 35, EPIC 70, LEGENDARY 200, BRAINROT 1000`; ×20 if holo.
  Cards with modifiers (section 5.4) are multiplied again: finish `SILVER ×10`, `GOLD ×40`,
  `PLATINUM ×200`, `DIAMOND ×1000`; misprint ×200. All multipliers stack. A card's id alone decides
  matches below: a gold copy and a plain copy of a card are a pair.
- Combo, from how many copies of each card id the pack holds, largest count `c1`, second `c2` (0 if
  none): `c1 ≥ 5` → **5 of a Kind ×10000**; `c1 = 4` → **4 of a Kind ×250**; `c1 = 3, c2 = 2` →
  **Full House ×150**; `c1 = 3` (any other `c2`) → **3 of a Kind ×15**; `c1 = 2, c2 = 2` →
  **Two Pair ×10**; `c1 = 2` → **Pair ×2**; otherwise **No Matches ×1**.
- **Brainrot Score = (sum of card points) × combo multiplier.**

**Hall of Fame:** a pull qualifies with a multiplier of at least 150 (Full House or better), or a
score of at least 20000.

## 9. Display (not part of verification)

- **Fingerprint**: the first 40 bits of SHA-256(public key) as 8 Crockford base32 characters
  (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), most significant first, written `XXXX-XXXX` (UIs show it
  after a `#`). Names are not unique; the name plus fingerprint identifies a player.
- **Names**: UIs SHOULD display names after NFC normalisation and removing Unicode category C
  characters, so look-alike names stay readable. This never affects whether a proof is valid.

## 10. What a valid proof does and doesn't show

It shows that the holder of that key pulled exactly these cards from that set by spending the ticket
with that number, and that nothing was edited. It doesn't show how many packs the player opened
(including in a script), so the Hall of Fame says who pulled something first, not who was luckiest.

## 11. Profiles

A **profile proof** is a player's signed list of which set each of their tickets went to, from ticket 0
with no gaps. It doesn't list cards: a verifier re-opens every pack itself (sections 4–5), so a profile
shows exactly what those tickets hold. It also **claims** its XP and its best few packs, so a viewer can
show the level at once and re-open the best packs first; once every pack is re-opened, the claims must
be exactly right. Share links look like `https://…/#/profile/<profile>`.

### 11.1 Format

base64url (section 2) of these bytes:

| Bytes | Field |
| --- | --- |
| 1 | profile version, `0x01` |
| 32 | player public key (Ed25519) |
| 1 + n | display name: length byte `n` (0 … 255), then UTF-8 |
| 1 | number of sets in the table, `t` (1 … 64) |
| t × (1 + n + 2) | each set: id length byte `n` (1 … 64), UTF-8 id, u16be version |
| varint | number of runs, `r` (≥ 1) |
| r × (varint, varint) | each run: set index into the table, then ticket count (≥ 1) |
| varint | claimed XP (section 11.3) |
| 1 | number of highlights, `h` = min(5, N) |
| h × varint | highlights: ticket numbers of the best packs, best first |
| 64 | Ed25519 signature |

The signed message is `UTF-8("brainrot-tcg/profile/v1") || <every byte before the signature>`. (The
different prefix means a pull proof's signature never verifies as a profile, or the other way round.)

Runs cover tickets in order: the first run's `count` tickets are tickets `0 … count−1` in its set, the
next run continues from there, and so on. The profile covers tickets `0 … N−1`, where N is the sum of
the counts.

### 11.2 Verification

Apply these checks in this order and reject at the first that fails, reporting the rule (the `rule`
of each `invalidProfiles` vector):

1. **`decode`.** base64url, varints and UTF-8 are canonical (section 2); the version byte is 1; every
   field is present and nothing follows the signature; and the encoding is canonical:
   - the table has 1 … 64 entries, each set id is 1 … 64 bytes, and no `(id, version)` appears twice;
   - there is at least one run; every run's index is less than `t` and its count is at least 1;
   - sets appear in the table **in order of first use**: walking the runs, each index is at most the
     number of distinct indexes seen so far;
   - two consecutive runs never have the same index (they would be one run);
   - every table entry is used by some run;
   - N, the total ticket count, is at most **100 000** (this bounds a verifier's work);
   - `h` is exactly min(5, N), every highlight is less than N, and no highlight appears twice.
2. **`name`**, 3. **`publicKey`**, 4. **`signature`**: exactly as in section 7, with this section's
   signed message.
5. **`set`.** Every `id@version` in the table exists.

Then for each ticket `n` in `0 … N−1`, derive its pack in its run's set (sections 4–5) and score it
(section 8). Finally:

6. **`claims`.** The claimed XP equals the XP of the derived packs (section 11.3), and the highlights
   are exactly the `h` best packs in order: by score, highest first, and for equal scores the lower
   ticket number first.

A verifier MAY re-open the highlights first and show the claimed level before step 6, as long as it
says the level is only claimed until step 6 passes.

### 11.3 Level

Computed from the derived packs only:

- **XP** = 10 per pack, + 25 per distinct card (by set id and card id; a holo and a normal copy are
  the same card), + a bonus per pack by its combo: Two Pair 5, 3 of a Kind 5, Full House 50, 4 of a
  Kind 100, 5 of a Kind 1000 (others 0).
- **Level** = the largest `L ≥ 1` with `50 × L × (L − 1) ≤ XP` (level 2 at 100 XP, 3 at 300, 4 at
  600, …).

### 11.4 What a valid profile does and doesn't show

It shows every pack that key opened from its first ticket up to ticket N−1, with nothing left out
or edited, and the level those packs earn. It can't show packs opened after the profile was made
(only stop early, which can only make it smaller), that ticket `n` was opened in that set and no other
(re-mining one ticket in several sets costs a full ticket each), or that two keys belong to different
people.

## 12. Versions

Every link that has ever verified must keep verifying, so nothing here is ever changed in place.

- **Formats.** A pull proof starts with version byte `0x01` and a profile with its own `0x01`. A
  verifier MUST reject any version it doesn't implement (rule `decode`), never guess. A new format gets
  the next version byte **and** a new signed-message prefix (`brainrot-tcg/proof/v2`), so a signature
  made for one format can never verify as another. Verifiers keep accepting every older version.
- **Tickets.** The ticket preimage starts with `brainrot-tcg/ticket/v1` and the salt is fixed
  (section 4). Changing the Argon2id parameters, the preimage or the salt means a new ticket version,
  chosen per set version, so existing set versions keep v1 tickets forever.
- **Sets.** `id@version` is immutable once released: anything that changes which pack a ticket yields
  (cards, their order, rarities, odds, pack size) needs a new version, and every released version stays
  available for verification (enforced by `src/content/sets.lock.json` in CI). Names, captions, flavor
  text and art may change freely; they don't affect packs.
- **Rules.** Scoring (section 8), Hall of Fame thresholds and levels (section 11.3) can only change
  with a new spec version, published alongside the old one; leaderboards say which they use.
- **Modifier tables.** A set version opts into a modifier table with `modifiers` (section 5.4); a
  table never changes once published, and set versions without `modifiers` never roll them. Adding
  table 1 changed no existing pull: their cards, points and scores are exactly as before.
- **Test vectors** for a version are never edited, only added to.
