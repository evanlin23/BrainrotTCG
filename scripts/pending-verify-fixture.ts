/**
 * Writes the signed pulls tests/performance/pending-verify.spec.ts serves from its stand-in relays
 * (#777): `count` pulls of the default set that each qualify for the Hall of Fame, one per
 * throwaway key, sent just now. Nothing is sent anywhere.
 *
 *   npx tsx scripts/pending-verify-fixture.ts [count=10] [out=test-results/pending-verify-fixture.json]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { derivePack, encodeProof, publicKeyFromSecret, pullId, qualifiesForHallOfFame, scorePack, signProof, toHex, utf8 } from '../src/engine';
import { DEFAULT_SET_ID, getLatestSet } from '../src/content/sets';
import { hallOfFameEvent, type NostrEvent } from '../src/game/nostrInbox';

const count = Number(process.argv[2] ?? 10);
const out = process.argv[3] ?? 'test-results/pending-verify-fixture.json';
if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error(`count must be an integer from 1 to 50, got "${process.argv[2]}"`);

const set = getLatestSet(DEFAULT_SET_ID)!;
const now = Date.now();
const events: NostrEvent[] = [];
const keys: string[] = [];
for (let i = 0; events.length < count; i++) {
  const secretKey = sha256(utf8(`pending-verify-${i}`));
  const publicKey = publicKeyFromSecret(secretKey);
  // The first qualifying nonce for this key, if one comes soon; otherwise the next key.
  for (let nonce = 0; nonce < 40; nonce++) {
    const cards = await derivePack(set, publicKey, nonce);
    if (!qualifiesForHallOfFame(scorePack(cards.map((c) => ({ ...c, cardId: `${c.setId}/${c.cardId}` }))))) continue;
    const proof = signProof({ setId: set.id, setVersion: set.version, publicKey, nonce, name: `Pending ${i}` }, secretKey);
    events.push(hallOfFameEvent(encodeProof(proof), pullId(proof), now - events.length * 1000));
    keys.push(toHex(publicKey));
    break;
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ set: { id: set.id, name: set.name }, events, keys }));
console.log(`${count} qualifying pending pulls of ${set.id}@${set.version} written to ${out}`);
