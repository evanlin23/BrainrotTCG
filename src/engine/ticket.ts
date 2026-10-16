import { argon2id } from 'hash-wasm';
import { toHex, utf8 } from './bytes';

/**
 * A ticket is the proof-of-work behind one pack: a memory-hard hash of
 * (set@version, player public key, nonce). Every pack costs one ticket, so
 * fishing for a lucky pack costs exactly as much as opening packs honestly.
 *
 * Changing these parameters changes every pack, so it requires a new ticket
 * version (old versions must stay verifiable).
 */
export const TICKET_VERSION = 1;

export const TICKET_PARAMS = {
  memorySize: 32 * 1024, // KiB
  iterations: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

const SALT = utf8('brainrot-tcg/ticket-salt/v1');

export const ticketPreimage = (setKey: string, publicKey: Uint8Array, nonce: number): string =>
  `brainrot-tcg/ticket/v${TICKET_VERSION}|${setKey}|${toHex(publicKey)}|${nonce}`;

export const computeTicket = async (setKey: string, publicKey: Uint8Array, nonce: number): Promise<Uint8Array> => {
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid nonce');
  return argon2id({
    password: utf8(ticketPreimage(setKey, publicKey, nonce)),
    salt: SALT,
    ...TICKET_PARAMS,
    outputType: 'binary',
  });
};
