import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { PROFILE, REPETITIONS } from '../tests/performance/report';
import { EVIDENCE, OPTIONAL_HISTORY_RECORDS, summarizeOptional, type OptionalRun, type OptionalScenario } from '../tests/performance/optional-work';

/** Writes the optional-work fixture's raw runs and summary, labelled as emulation (docs/DEVELOPMENT.md). */
export default class OptionalWorkReporter implements Reporter {
  private runs: OptionalRun[] = [];
  private output = '';
  private metadata: object = {};
  onBegin(config: FullConfig) {
    this.output = config.projects[0].outputDir;
    this.metadata = {
      schemaVersion: 1, evidence: EVIDENCE, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      trackedSourceDirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(),
      runner: `Playwright ${createRequire(import.meta.url)('@playwright/test/package.json').version}`,
      node: process.version, createdAt: new Date().toISOString(), profile: PROFILE,
      machine: { platform: process.platform, arch: process.arch, cpuModel: cpus()[0]?.model, logicalCPUs: cpus().length, hostMemoryBytes: totalmem() },
      repetitions: REPETITIONS, timingGate: false,
      fixtures: {
        'optional-inactive': { historyRecords: OPTIONAL_HISTORY_RECORDS, optionalWork: 'none: every record has its cards' },
        'optional-active': { historyRecords: OPTIONAL_HISTORY_RECORDS, optionalWork: 'the same records without cards and an unfinished re-open, so the app re-mines them in the background' },
        authenticity: 'shape-only synthetic records, NOT verified tickets, proof or profile evidence; disposable public seed01 identity, no real saves',
        measuredOpening: 'real production ticket/crypto/opening; pressed once the live ticket is ready (and, when active, optional tickets are mining)',
      },
      limits: ['Desktop Chromium with CDP viewport/CPU/network settings; not a phone, its RAM, GPU or thermal limits (real devices: #8)',
        'CDP CPU slowdown targets the page; workers run unthrottled on the host CPUs, so contention depends on this host',
        'Worker counts come from the page; pool size follows the emulated navigator.hardwareConcurrency/deviceMemory recorded per run',
        'estimatedArgon2PeakBytes is peak busy workers x Argon2 memory per job, an estimate; it is never measured',
        'Measured memory is the main target JS heap only; it excludes workers, WASM, process and GPU memory',
        'open-to-summary/result exclude ticket mining (the live ticket is ready first); liveTicketMs reports that separately',
        'Optional work is held from the tear to the summary only; open-to-result also covers summary image decode after it is freed'],
    };
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const [scenario, repetition] = test.title.split(' / ');
    const body = result.attachments.find((a) => a.name === 'performance-measurement')?.body;
    this.runs.push({
      scenario: scenario as OptionalScenario, repetition: Number(repetition), status: result.status,
      ...(body ? { measurement: JSON.parse(body.toString()) } : {}),
      ...(result.errors.length ? { error: result.errors.map((error) => error.message?.replaceAll(process.cwd(), '<checkout>').slice(0, 2000)).join('\n') } : {}),
    });
  }
  onEnd(result: FullResult) {
    mkdirSync(this.output, { recursive: true });
    writeFileSync(join(this.output, 'raw-runs.json'), JSON.stringify({ ...this.metadata, status: result.status, runs: this.runs }, null, 2));
    writeFileSync(join(this.output, 'summary.json'), JSON.stringify({ ...this.metadata, status: result.status, scenarios: summarizeOptional(this.runs) }, null, 2));
  }
}
