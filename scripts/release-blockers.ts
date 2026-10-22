import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isMainModule } from './main-module.ts';

/**
 * Release-blocker record and deterministic promotion-eligibility decision (#759).
 *
 * The record lives at config/release-blockers.json and changes only through reviewed PRs to main.
 * The promotion gate (#706) is expected to read it from the exact candidate commit and call
 * `evaluateReleaseEligibility`; until that gate lands this script is advisory and does not by itself
 * stop a deploy. Every rule below fails closed: anything missing, malformed, stale or unverifiable
 * makes the candidate ineligible with a reason that says what to fix.
 */

export const RECORD_PATH = 'config/release-blockers.json';
export const RECORD_VERSION = 1;

/** Logins whose specific, linked decision can approve an exception or corrective release. */
export const TRUSTED_APPROVERS: readonly string[] = ['evanlin23'];
/** Approval references must point at a specific decision in this repository. */
export const APPROVAL_REF_PREFIX = 'https://github.com/evanlin23/BrainrotTCG/';
/** A mitigation exception may last at most this long from its approval before it must be renewed. */
export const MAX_EXCEPTION_DAYS = 30;

export const BLOCKER_CATEGORIES = ['save_loss', 'broken_proof', 'startup_blank', 'inaccessible_core'] as const;
export const BLOCKER_CLASSIFICATIONS = [
  'regression',
  'older_defect',
  'unverified_hypothesis',
  'missing_device_evidence',
] as const;
export const BLOCKER_DISPOSITIONS = ['resolved', 'unresolved', 'mitigated_exception', 'corrective_release'] as const;

export type BlockerCategory = (typeof BLOCKER_CATEGORIES)[number];
export type BlockerClassification = (typeof BLOCKER_CLASSIFICATIONS)[number];
export type BlockerDisposition = (typeof BLOCKER_DISPOSITIONS)[number];

export interface BlockerResolution {
  fixedInPr: number;
  /** Full 40-hex commit on main that carries the fix; it must be in the candidate's history. */
  fixCommit: string;
  /** Regression test path; it must exist in the candidate, whose full test run must pass. */
  regressionTest: string;
}

export interface Approval {
  approvedBy: string;
  /** Link to the specific comment or review that accepted this exact decision. */
  approvalRef: string;
  approvedAt: string;
}

export interface BlockerMitigation extends Approval {
  scope: string;
  rationale: string;
  mitigationEvidence: string;
  expiresAt: string;
  followUpIssue: number;
}

export interface CorrectiveReleaseDetails extends Approval {
  /** The exact candidate commit this corrective release was reviewed for. */
  candidateHead: string;
  nonWorseningEvidence: string;
  compatibilityEvidence: string;
}

export interface ReleaseBlocker {
  id: string;
  canonicalIssue: number;
  title: string;
  category: BlockerCategory;
  classification: BlockerClassification;
  affectedRevisions: string[];
  scenario: string;
  severityRationale: string;
  owner: string;
  requiredEvidence: string;
  disposition: BlockerDisposition;
  resolution?: BlockerResolution;
  mitigation?: BlockerMitigation;
  correctiveRelease?: CorrectiveReleaseDetails;
}

export interface ReleaseBlockersRecord {
  version: number;
  description: string;
  blockers: ReleaseBlocker[];
}

export interface ReleaseEligibilityOptions {
  blockersRecord: unknown;
  /** Full 40-hex SHA of the exact candidate being promoted. */
  candidateHead?: string;
  /** Set only when the candidate is declared as the corrective release for this canonical issue. */
  correctiveTargetIssue?: number;
  currentTime?: Date;
  /** True when `ancestor` is `descendant` or in its history. Missing means fixes can't be verified. */
  isAncestor?: (ancestor: string, descendant: string) => boolean;
  /** True when `path` exists in the candidate tree. Missing means regression tests can't be verified. */
  fileExistsAtCandidate?: (path: string) => boolean;
}

export interface ReleaseEligibilityResult {
  eligible: boolean;
  unresolvedBlockers: string[];
  activeExceptions: string[];
  correctiveRelease: string | null;
  resolvedCount: number;
  reasons: string[];
}

const SHA_RE = /^[0-9a-f]{40}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isSha = (v: unknown): v is string => typeof v === 'string' && SHA_RE.test(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const time = (v: unknown): number => (nonEmpty(v) ? Date.parse(v) : Number.NaN);

/** Problems with an approval block, or [] when it is a specific, trusted, dated decision. */
function approvalProblems(label: string, a: Record<string, unknown>, now: number): string[] {
  const problems: string[] = [];
  if (!oneOf(TRUSTED_APPROVERS, a.approvedBy)) {
    problems.push(`${label} approvedBy ${JSON.stringify(a.approvedBy)} is not a trusted approver (${TRUSTED_APPROVERS.join(', ')})`);
  }
  if (!nonEmpty(a.approvalRef) || !a.approvalRef.startsWith(APPROVAL_REF_PREFIX)) {
    problems.push(`${label} approvalRef must link the specific decision under ${APPROVAL_REF_PREFIX}`);
  }
  const at = time(a.approvedAt);
  if (Number.isNaN(at)) problems.push(`${label} approvedAt is missing or not a timestamp`);
  else if (at > now) problems.push(`${label} approvedAt is in the future`);
  return problems;
}

/** Problems with fields every blocker needs, or [] when the entry is well formed. */
function entryProblems(b: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!nonEmpty(b.id)) problems.push('id');
  if (!positiveInt(b.canonicalIssue)) problems.push('canonicalIssue');
  for (const f of ['title', 'scenario', 'severityRationale', 'owner', 'requiredEvidence'] as const) {
    if (!nonEmpty(b[f])) problems.push(f);
  }
  if (!oneOf(BLOCKER_CATEGORIES, b.category)) problems.push(`category (one of ${BLOCKER_CATEGORIES.join(', ')})`);
  if (!oneOf(BLOCKER_CLASSIFICATIONS, b.classification)) {
    problems.push(`classification (one of ${BLOCKER_CLASSIFICATIONS.join(', ')})`);
  }
  if (!Array.isArray(b.affectedRevisions) || b.affectedRevisions.length === 0 || !b.affectedRevisions.every(nonEmpty)) {
    problems.push('affectedRevisions');
  }
  if (!oneOf(BLOCKER_DISPOSITIONS, b.disposition)) problems.push(`disposition (one of ${BLOCKER_DISPOSITIONS.join(', ')})`);
  return problems;
}

/**
 * Decides whether one exact candidate may be promoted. Eligible only when every recorded blocker is
 * resolved in the candidate, covered by an active approved exception, or the candidate is the
 * approved corrective release for one blocker (other unresolved blockers then stay listed but do not
 * block that candidate only).
 */
export function evaluateReleaseEligibility(options: ReleaseEligibilityOptions): ReleaseEligibilityResult {
  const { blockersRecord: record, candidateHead, correctiveTargetIssue, isAncestor, fileExistsAtCandidate } = options;
  const now = (options.currentTime ?? new Date()).getTime();
  const reasons: string[] = [];
  const unresolved: string[] = [];
  const tolerated: ReleaseBlocker[] = [];
  const activeExceptions: string[] = [];
  let correctiveRelease: string | null = null;
  let resolvedCount = 0;

  const fail = (reason: string, id?: string) => {
    reasons.push(reason);
    if (id) unresolved.push(id);
  };
  const result = (): ReleaseEligibilityResult => ({
    eligible: reasons.length === 0,
    unresolvedBlockers: [...unresolved, ...tolerated.map((b) => b.id)],
    activeExceptions,
    correctiveRelease,
    resolvedCount,
    reasons,
  });

  if (!isObject(record) || !Array.isArray(record.blockers)) {
    fail(`Release blockers record is missing or malformed; restore ${RECORD_PATH}`, 'INVALID_RECORD');
    return result();
  }
  if (record.version !== RECORD_VERSION) {
    fail(`Release blockers record version ${JSON.stringify(record.version)} is not ${RECORD_VERSION}`, 'INVALID_RECORD');
    return result();
  }
  if (!isSha(candidateHead)) {
    fail('Candidate head is missing or not a full 40-hex commit SHA; eligibility is unknown', 'UNKNOWN_CANDIDATE');
    return result();
  }
  if (correctiveTargetIssue !== undefined && !positiveInt(correctiveTargetIssue)) {
    fail('Corrective release target issue must be a positive issue number', 'INVALID_CORRECTIVE_TARGET');
    return result();
  }

  const seenIds = new Set<string>();
  const seenIssues = new Set<number>();
  for (const [index, raw] of record.blockers.entries()) {
    if (!isObject(raw)) {
      fail(`Blocker entry ${index} is not an object`, `ENTRY_${index}`);
      continue;
    }
    const missing = entryProblems(raw);
    const id = nonEmpty(raw.id) ? raw.id : `ENTRY_${index}`;
    if (missing.length > 0) {
      fail(`Blocker ${id} is missing or has invalid: ${missing.join('; ')}`, id);
      continue;
    }
    const b = raw as unknown as ReleaseBlocker;
    if (seenIds.has(b.id) || seenIssues.has(b.canonicalIssue)) {
      fail(`Blocker ${b.id} duplicates another entry's id or canonical issue #${b.canonicalIssue}`, b.id);
      continue;
    }
    seenIds.add(b.id);
    seenIssues.add(b.canonicalIssue);
    const label = `Blocker ${b.id} (#${b.canonicalIssue})`;

    switch (b.disposition) {
      case 'resolved': {
        const r = isObject(b.resolution) ? b.resolution : undefined;
        if (!r || !positiveInt(r.fixedInPr) || !isSha(r.fixCommit) || !nonEmpty(r.regressionTest)) {
          fail(`${label} is marked resolved without fixedInPr, a full fixCommit SHA and a regressionTest path`, b.id);
        } else if (!isAncestor) {
          fail(`${label} fix commit cannot be checked against the candidate; treating as unresolved`, b.id);
        } else if (!isAncestor(r.fixCommit, candidateHead)) {
          fail(`${label} fix commit ${r.fixCommit} is not in candidate ${candidateHead}; the disposition is stale`, b.id);
        } else if (!fileExistsAtCandidate || !fileExistsAtCandidate(r.regressionTest)) {
          fail(`${label} regression test ${r.regressionTest} is not present in the candidate`, b.id);
        } else {
          resolvedCount++;
        }
        break;
      }
      case 'mitigated_exception': {
        const m = isObject(b.mitigation) ? b.mitigation : undefined;
        if (!m) {
          fail(`${label} is a mitigated exception without mitigation details`, b.id);
          break;
        }
        const problems = approvalProblems(label, m, now);
        for (const f of ['scope', 'rationale', 'mitigationEvidence'] as const) {
          if (!nonEmpty(m[f])) problems.push(`${label} mitigation ${f} is missing`);
        }
        if (!positiveInt(m.followUpIssue)) problems.push(`${label} mitigation followUpIssue is missing`);
        const expires = time(m.expiresAt);
        const approved = time(m.approvedAt);
        if (Number.isNaN(expires)) problems.push(`${label} mitigation expiresAt is missing or not a timestamp`);
        else if (now >= expires) problems.push(`${label} mitigation expired at ${String(m.expiresAt)}; recheck and renew or resolve it`);
        else if (!Number.isNaN(approved) && expires - approved > MAX_EXCEPTION_DAYS * DAY_MS) {
          problems.push(`${label} mitigation lasts more than ${MAX_EXCEPTION_DAYS} days from approval`);
        }
        if (problems.length > 0) {
          problems.forEach((p) => reasons.push(p));
          unresolved.push(b.id);
        } else {
          activeExceptions.push(b.id);
        }
        break;
      }
      case 'corrective_release': {
        if (correctiveTargetIssue !== b.canonicalIssue) {
          fail(`${label} has a corrective-release disposition, but this candidate is not declared as its corrective release`, b.id);
          break;
        }
        const c = isObject(b.correctiveRelease) ? b.correctiveRelease : undefined;
        if (!c) {
          fail(`${label} corrective release has no approval details`, b.id);
          break;
        }
        const problems = approvalProblems(label, c, now);
        if (!nonEmpty(c.nonWorseningEvidence)) problems.push(`${label} corrective release nonWorseningEvidence is missing`);
        if (!nonEmpty(c.compatibilityEvidence)) problems.push(`${label} corrective release compatibilityEvidence is missing`);
        if (!isSha(c.candidateHead)) problems.push(`${label} corrective release candidateHead is not a full SHA`);
        else if (c.candidateHead !== candidateHead) {
          problems.push(`${label} corrective release was approved for ${c.candidateHead}, not candidate ${candidateHead}; the approval is stale`);
        }
        if (problems.length > 0) {
          problems.forEach((p) => reasons.push(p));
          unresolved.push(b.id);
        } else {
          correctiveRelease = b.id;
        }
        break;
      }
      case 'unresolved':
        // Decided after the loop: only a valid corrective release for another issue tolerates it.
        tolerated.push(b);
        break;
    }
  }

  if (correctiveTargetIssue !== undefined && correctiveRelease === null) {
    const target = record.blockers.find((b) => isObject(b) && b.canonicalIssue === correctiveTargetIssue);
    if (!isObject(target) || target.disposition !== 'corrective_release') {
      fail(
        `Candidate is declared as a corrective release for #${correctiveTargetIssue}, but the record has no corrective-release entry for that issue`,
        'INVALID_CORRECTIVE_TARGET',
      );
    }
  }
  if (correctiveRelease === null) {
    for (const b of tolerated) {
      reasons.push(`Unresolved release blocker ${b.id} (#${b.canonicalIssue}: ${b.title}); needs ${b.requiredEvidence}`);
    }
  }
  return result();
}

/**
 * Lists record changes that relax release permission without a reviewed resolution: dropping a
 * blocker that was not resolved, or rewriting an existing blocker's identity. Disposition changes
 * are covered by `evaluateReleaseEligibility`, which requires trusted, linked approval or a fix in
 * the candidate. Run it against the record on main (the reviewed authority) before trusting a change.
 */
export function unauthorizedRecordChanges(base: unknown, head: unknown): string[] {
  if (!isObject(base) || !Array.isArray(base.blockers)) return [];
  const headBlockers = isObject(head) && Array.isArray(head.blockers) ? head.blockers.filter(isObject) : [];
  const problems: string[] = [];
  for (const old of base.blockers.filter(isObject)) {
    const now = headBlockers.find((b) => b.id === old.id);
    if (!now) {
      if (old.disposition !== 'resolved') {
        problems.push(`Blocker ${String(old.id)} was removed while ${String(old.disposition)}; only resolved entries may be pruned`);
      }
      continue;
    }
    if (now.canonicalIssue !== old.canonicalIssue || now.category !== old.category) {
      problems.push(`Blocker ${String(old.id)} changed its canonical issue or category; add a new entry instead`);
    }
  }
  return problems;
}

/** sha256 of the record bytes the decision was made on, for the promotion gate to log and bind. */
export const recordDigest = (raw: string): string => createHash('sha256').update(raw).digest('hex');

interface CliArgs {
  candidate?: string;
  base?: string;
  correctiveTarget?: number;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--candidate') args.candidate = value;
    else if (flag === '--base') args.base = value;
    else if (flag === '--corrective-target') args.correctiveTarget = Number(value);
    else throw new Error(`Unknown argument ${flag}`);
    i++;
  }
  return args;
}

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitOk = (...args: string[]): boolean => {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
};

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args.candidate) throw new Error('Pass --candidate <commit>: eligibility is decided for one exact candidate');
  const candidate = git('rev-parse', '--verify', `${args.candidate}^{commit}`).trim();
  const raw = git('show', `${candidate}:${RECORD_PATH}`);
  const record: unknown = JSON.parse(raw);
  const result = evaluateReleaseEligibility({
    blockersRecord: record,
    candidateHead: candidate,
    correctiveTargetIssue: args.correctiveTarget,
    isAncestor: (a, d) => gitOk('merge-base', '--is-ancestor', a, d),
    fileExistsAtCandidate: (p) => gitOk('cat-file', '-e', `${candidate}:${p}`),
  });
  if (args.base) {
    const baseRaw = git('show', `${args.base}:${RECORD_PATH}`);
    for (const p of unauthorizedRecordChanges(JSON.parse(baseRaw), record)) result.reasons.push(p);
    result.eligible = result.reasons.length === 0;
  }
  console.log(`Candidate ${candidate}, record sha256 ${recordDigest(raw)}`);
  if (result.eligible) {
    console.log(
      `Release eligible: ${result.resolvedCount} resolved, ${result.activeExceptions.length} active exceptions` +
        (result.correctiveRelease ? `, corrective release for ${result.correctiveRelease}` : '') +
        `, ${result.unresolvedBlockers.length} still tracked.`,
    );
    return 0;
  }
  console.error('Release blocked:');
  result.reasons.forEach((r) => console.error(`  - ${r}`));
  return 1;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Failed to verify release blockers: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
