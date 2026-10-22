// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp, type TicketReply } from './mountedApp';
import { SETS } from '../content/sets';
import { encodeProof, publicKeyFromSecret, signProof } from '../engine';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => {
  Reflect.deleteProperty(navigator, 'clipboard');
  await app?.dispose();
  app = undefined;
});

const PLAYER = { 'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Route fixture', nextNonce: 0, createdAt: 1 }) };
const QUIET = { 'brainrot-settings-v1': JSON.stringify({ effectsVolume: 0 }) };

const sharer = new Uint8Array(32).fill(2);
const NONCE_A = 5;
const NONCE_B = 6;
const proofFor = (nonce: number, name: string) => {
  const set = SETS[0];
  return encodeProof(signProof({ setId: set.id, setVersion: set.version, publicKey: publicKeyFromSecret(sharer), nonce, name }, sharer));
};
const proofA = proofFor(NONCE_A, 'Alpha Ripper');
const proofB = proofFor(NONCE_B, 'Beta Ripper');

/** How long (on the fake clock) the worker holds each shared pull's ticket; undefined answers at once. */
const holdTickets = (hold: { a?: number; b?: number }) => (request: { nonce: number }): TicketReply | undefined => {
  const delayMs = request.nonce === NONCE_A ? hold.a : request.nonce === NONCE_B ? hold.b : undefined;
  return delayMs === undefined ? undefined : { delayMs };
};
const text = () => document.body.textContent ?? '';
const copyButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.includes('Copy link'));
const expectChecking = () => {
  expect(text()).toContain('Re-opening the pack on your device');
  expect(text()).not.toContain('Verified on this device');
  expect(text()).not.toContain('Alpha Ripper');
  expect(text()).not.toContain(`#${NONCE_A}`);
  expect(copyButton()).toBeUndefined();
};

it("retires verified pull A when only the hash changes to pending pull B, then copies B's link", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const hold: { a?: number; b?: number } = { b: 5_000 };
  app = await mountedApp({ ...PLAYER, ...QUIET }, { tickets: holdTickets(hold) });
  history.replaceState(null, '', `/BrainrotTCG/#/pull/${proofA}`);
  await app.mount();
  await app.until('pull A verifies', () => {
    expect(text()).toContain('Verified on this device');
    expect(text()).toContain('Alpha Ripper');
    expect(text()).toContain(`#${NONCE_A}`);
  });

  // Same open sheet, hash-only change; B's ticket is held by the worker.
  await app.interact(() => { location.hash = `#/pull/${proofB}`; });
  await app.settle(100);
  expectChecking();

  await app.until('pull B verifies', () => {
    expect(text()).toContain('Verified on this device');
    expect(text()).toContain('Beta Ripper');
    expect(text()).toContain(`#${NONCE_B}`);
  });
  expect(text()).not.toContain('Alpha Ripper');

  // B's own preview, from a second check of the same proof (no hold this time).
  const { checkPull, previewFor, pullUrl } = await import('../game/pulls');
  hold.b = undefined;
  const checkedB = await checkPull(proofB);
  await app.interact(() => copyButton()!.click());
  expect(writeText).toHaveBeenCalledTimes(1);
  const link = (writeText.mock.calls[0] as unknown as [string])[0];
  expect(link).toBe(pullUrl(proofB, previewFor(checkedB.cardsWithMeta)));
  expect(link).not.toContain(proofA);
}, 60_000);

it('does not let a late completion of A overwrite B after a hash-only route change', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET }, { tickets: holdTickets({ a: 3_000, b: 8_000 }) });
  history.replaceState(null, '', `/BrainrotTCG/#/pull/${proofA}`);
  await app.mount();
  await app.settle(100);
  expectChecking();

  await app.interact(() => { location.hash = `#/pull/${proofB}`; });
  // A's held ticket arrives while B is still pending: nothing of A may show.
  await app.settle(4_000);
  expectChecking();

  await app.until('pull B verifies', () => {
    expect(text()).toContain('Verified on this device');
    expect(text()).toContain('Beta Ripper');
  });
  expect(text()).not.toContain('Alpha Ripper');
  expect(text()).not.toContain(`#${NONCE_A}`);
}, 60_000);
