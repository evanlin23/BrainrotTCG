import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { PROFILE, REPETITIONS, summarize, type Run, type Scenario } from '../tests/performance/report';

export default class PerformanceReporter implements Reporter {
  private runs: Run[] = [];
  private output = '';
  private metadata: object = {};
  onBegin(config: FullConfig) {
    this.output = config.projects[0].outputDir;
    this.metadata = {
      schemaVersion: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      trackedSourceDirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(),
      runner: `Playwright ${createRequire(import.meta.url)('@playwright/test/package.json').version}`,
      node: process.version, createdAt: new Date().toISOString(), profile: PROFILE,
      machine: { platform: process.platform, arch: process.arch, cpuModel: cpus()[0]?.model, logicalCPUs: cpus().length, hostMemoryBytes: totalmem() },
      conditions: `Emulated, not a real device: headless Chromium only; CDP ${PROFILE.cpuSlowdown}x CPU slowdown, `
        + `${PROFILE.network.downloadThroughput * 8 / 1e6}/${PROFILE.network.uploadThroughput * 8 / 1e6} Mbps down/up, ${PROFILE.network.latency} ms latency, `
        + `${PROFILE.viewport.width}x${PROFILE.viewport.height} viewport`,
      repetitions: REPETITIONS, timingGate: false, intentionalFailureProbe: process.env.PERF_INJECT_FUNCTIONAL_FAILURE === '1',
      fixtures: {
        'first-cold': { historyRecords: 0, cache: 'cleared HTTP browser cache; fresh context/storage' },
        'synthetic-history-cold': { historyRecords: 100, cache: 'cleared HTTP browser cache; fresh context/storage', authenticity: 'shape-only cached cards repeated across 100 nonce records; NOT verified tickets, proof or valid profile evidence' },
        'first-warm': { historyRecords: 0, cache: 'warm: same context after an unthrottled priming run of the same journey; HTTP cache and IndexedDB kept (the pack cache only stores re-opened packs, so this journey leaves it empty), localStorage reset and garbage collected so the measured run mines the same ticket on a clean heap; no service worker exists' },
        'synthetic-history-warm': { historyRecords: 100, cache: 'warm: as first-warm, with the same synthetic history re-seeded after the reset', authenticity: 'as synthetic-history-cold' },
        measuredOpening: 'real production ticket/crypto/opening; disposable public seed01 identity, no real saves',
      },
      limits: ['CDP viewport/CPU/network settings do not emulate phone RAM, GPU or a physical device',
        'Heap measures main target JS only, excludes workers/WASM/process/GPU and is not device RAM',
        'Frames are requestAnimationFrame intervals, not compositor FPS; long tasks describe main thread only',
        'Transfer is page-target-observed CDP encodedDataLength at result completion; outstanding requests counted; not full Worker/process bandwidth',
        'Trace instrumentation enabled consistently; headless Chromium, report-only timings',
        'first-clickable is automation-observed trial-click readiness after wrapper decoding; includes dispatch overhead',
        'open-to-result includes remaining ticket work after navigation-time prefetch, not total Argon2 duration',
        'Measured commit is this checkout, not deployed main or Cloudflare cache performance',
        'Cold runs clear and disable the HTTP cache (Playwright routing disables it anyway); warm runs keep it and guard HTTP with page-target CDP Fetch instead of context routing, and fail if any other page opens',
        'Warm runs revalidate against vite preview (Cache-Control: no-cache, ETag); notModifiedRequests counts 304s on the wire, which the page sees as cached 200s; GitHub Pages and Cloudflare cache headers differ, so warm numbers are not deployed-site numbers',
        'Cold isolation matches the browser smoke context HTTP/WebSocket routing; warm runs keep its WebSocket routing; Worker HTTP interception is probed in both, Worker WebSockets are not proven guarded',
        'Audited production ticket.worker.ts computes tickets only; no universal sandbox for arbitrary future workers',
        'CPU/network CDP settings target the page; equivalent throttling of worker execution is not established'],
    };
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const [scenario, repetition] = test.title.split(' / ');
    const body = result.attachments.find((a) => a.name === 'performance-measurement')?.body;
    this.runs.push({
      scenario: scenario as Scenario, repetition: Number(repetition), status: result.status,
      ...(body ? { measurement: JSON.parse(body.toString()) } : {}),
      ...(result.errors.length ? { error: result.errors.map((error) => error.message?.replaceAll(process.cwd(), '<checkout>').slice(0, 2000)).join('\n') } : {}),
    });
  }
  onEnd(result: FullResult) {
    mkdirSync(this.output, { recursive: true });
    writeFileSync(join(this.output, 'raw-runs.json'), JSON.stringify({ ...this.metadata, status: result.status, runs: this.runs }, null, 2));
    writeFileSync(join(this.output, 'summary.json'), JSON.stringify({ ...this.metadata, status: result.status, scenarios: summarize(this.runs) }, null, 2));
  }
}
