/// <reference lib="webworker" />
/** Mines pack tickets (Argon2id) off the main thread so animations never stutter. */
import { computeTicket } from '../engine/ticket';
import { fromHex } from '../engine/bytes';

export interface TicketRequest {
  id: number;
  setKey: string;
  publicKeyHex: string;
  nonce: number;
}

export type TicketResponse = { id: number; ticket: Uint8Array } | { id: number; error: string };

self.onmessage = async (event: MessageEvent<TicketRequest>) => {
  const { id, setKey, publicKeyHex, nonce } = event.data;
  try {
    const ticket = await computeTicket(setKey, fromHex(publicKeyHex), nonce);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ticket } satisfies TicketResponse);
  } catch (error) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(error) } satisfies TicketResponse);
  }
};
