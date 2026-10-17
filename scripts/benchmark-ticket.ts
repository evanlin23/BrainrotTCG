/**
 * How long one ticket takes to mine (#36): the real `computeTicket` with the shipped TICKET_PARAMS,
 * timed in Node and in the main thread of a blank Chromium page at 1x and 4x CPU. Optional, report-only,
 * in no check or CI job: `npx tsx scripts/benchmark-ticket.ts [runs]` (default 7).
 *
 * It reads and writes nothing of a player's: no storage, no history, no network, a fixed throwaway key
 * and the nonces 0..runs. It never changes TICKET_PARAMS. CDP's CPU slowdown doesn't reach workers, so
 * the throttled figure runs the mining on the page's main thread instead; the app mines in a worker.
 * Chromium numbers are emulation, not a real device, and a GPU or ASIC miner isn't modelled.
 */
import { chromium } from '@playwright/test';
import { build } from 'vite';
import { computeTicket, TICKET_PARAMS } from '../src/engine/ticket';

const RUNS = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? 7);
if (!Number.isInteger(RUNS) || RUNS < 2) throw new Error('runs must be an integer of at least 2');
const SET_KEY = 'benchmark/ticket-latency';
const PUBLIC_KEY = Array.from({ length: 32 }, (_, i) => i);

interface Sample { label: string; times: number[] }
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const ms = (value: number) => `${value.toFixed(0)} ms`;
/** The first call also instantiates the WASM, so it's reported apart from the rest. */
const report = ({ label, times }: Sample) => {
  const [first, ...rest] = times;
  console.log(`${label}: median ${ms(median(rest))} (min ${ms(Math.min(...rest))}, max ${ms(Math.max(...rest))}, n=${rest.length}), first call ${ms(first)}`);
};

const nodeSample = async (): Promise<Sample> => {
  const times: number[] = [];
  for (let nonce = 0; nonce <= RUNS; nonce++) {
    const start = performance.now();
    await computeTicket(SET_KEY, Uint8Array.from(PUBLIC_KEY), nonce);
    times.push(performance.now() - start);
  }
  return { label: 'Node (no browser, no throttle)', times };
};

/** The engine's ticket module as one script, so the page runs the same code the app does. */
const bundleTicket = async (): Promise<string> => {
  const result = await build({
    configFile: false, logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry: 'src/engine/ticket.ts', formats: ['iife'], name: 'ticketEngine' } },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => ('output' in entry ? entry.output : []));
  const chunk = outputs.find((output) => output.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The ticket module did not bundle');
  return chunk.code;
};

const browserSamples = async (): Promise<Sample[]> => {
  const code = await bundleTicket();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const samples: Sample[] = [];
  try {
    for (const rate of [1, 4]) {
      // A fresh page per rate, so each pays its own WASM start-up.
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.addScriptTag({ content: code });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      const times = await page.evaluate(async ({ setKey, publicKey, runs }) => {
        const { computeTicket: mine } = (window as unknown as { ticketEngine: { computeTicket: typeof computeTicket } }).ticketEngine;
        const taken: number[] = [];
        for (let nonce = 0; nonce <= runs; nonce++) {
          const start = performance.now();
          await mine(setKey, Uint8Array.from(publicKey), nonce);
          taken.push(performance.now() - start);
        }
        return taken;
      }, { setKey: SET_KEY, publicKey: PUBLIC_KEY, runs: RUNS });
      samples.push({ label: `Chromium emulation, ${rate}x CPU, page main thread, not a real device`, times });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return samples;
};

console.log(`ticket cost: Argon2id, ${TICKET_PARAMS.memorySize / 1024} MiB, ${TICKET_PARAMS.iterations} passes, parallelism ${TICKET_PARAMS.parallelism} (unchanged)`);
report(await nodeSample());
for (const sample of await browserSamples()) report(sample);
