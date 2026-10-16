/// <reference lib="webworker" />
/** Mines pack tickets (Argon2id) off the main thread so animations never stutter. */
import { computeTicket, warmUpArgon2 } from '../engine/ticket';
import { fromHex } from '../engine/bytes';

export interface TicketRequest {
  id: number;
  setKey: string;
  publicKeyHex: string;
  nonce: number;
}

/** Compile the Argon2 WASM before the first ticket is asked for. Gets no reply. */
export interface WarmUpRequest {
  warmUp: true;
}

export type TicketResponse = { id: number; ticket: Uint8Array } | { id: number; error: string };

self.onmessage = async (event: MessageEvent<TicketRequest | WarmUpRequest>) => {
  if ('warmUp' in event.data) {
    await warmUpArgon2().catch(() => undefined); // the first ticket compiles it instead
    return;
  }
  const { id, setKey, publicKeyHex, nonce } = event.data;
  try {
    const ticket = await computeTicket(setKey, fromHex(publicKeyHex), nonce);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ticket } satisfies TicketResponse);
  } catch (error) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(error) } satisfies TicketResponse);
  }
};
