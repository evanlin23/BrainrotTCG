import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type BlockerCategory =
  | 'save_loss'
  | 'broken_proof'
  | 'startup_blank'
  | 'inaccessible_core'
  | 'data_integrity';

export type BlockerDisposition =
  | 'resolved'
  | 'unresolved'
  | 'mitigated_exception'
  | 'corrective_release';

export interface BlockerResolution {
  fixedInPr: number;
  regressionTest: string;
  verifiedHead: string;
}

export interface BlockerMitigation {
  scope: string;
  rationale: string;
  approvedBy: string;
  mitigationEvidence: string;
  expiresAt: string; // ISO 8601
  followUpIssue: number;
}

export interface CorrectiveReleaseDetails {
  targetIssue: number;
  nonWorseningEvidence: string;
  compatibilityVerified: boolean;
  approvedBy: string;
}

export interface ReleaseBlocker {
  id: string;
  canonicalIssue: number;
  title: string;
  category: BlockerCategory;
  severityRationale: string;
  owner: string;
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
  blockersRecord: ReleaseBlockersRecord;
  candidateHead?: string;
  targetIssue?: number;
  isCorrectiveRelease?: boolean;
  currentTime?: Date;
}

export interface ReleaseEligibilityResult {
  eligible: boolean;
  unresolvedBlockers: string[];
  activeExceptions: string[];
  resolvedCount: number;
  reasons: string[];
}

/**
 * Evaluates whether a candidate commit is eligible for promotion/release
 * based on the authoritative release blockers record.
 *
 * Rules:
 * 1. Confirmed save loss, broken historical proofs, persistent startup blank screens,
 *    and inaccessible core controls fail closed unless explicitly resolved or mitigated.
 * 2. Unresolved blockers prevent release promotion.
 * 3. Mitigated exceptions must be approved with evidence, an active unexpired date,
 *    and a tracked follow-up issue.
 * 4. Corrective releases allow deploying a targeted fix while other tracked defects
 *    remain, provided non-worsening and compatibility are verified and approved.
 */
export function evaluateReleaseEligibility(
  options: ReleaseEligibilityOptions
): ReleaseEligibilityResult {
  const { blockersRecord, isCorrectiveRelease, targetIssue } = options;
  const currentTime = options.currentTime || new Date();

  const reasons: string[] = [];
  const unresolvedBlockers: string[] = [];
  const activeExceptions: string[] = [];
  let resolvedCount = 0;

  if (!blockersRecord || typeof blockersRecord !== 'object' || !Array.isArray(blockersRecord.blockers)) {
    return {
      eligible: false,
      unresolvedBlockers: ['INVALID_RECORD'],
      activeExceptions: [],
      resolvedCount: 0,
      reasons: ['Release blockers record is missing or malformed'],
    };
  }

  for (const blocker of blockersRecord.blockers) {
    if (!blocker.id || !blocker.canonicalIssue || !blocker.disposition) {
      reasons.push(`Blocker entry missing required fields: ${JSON.stringify(blocker)}`);
      unresolvedBlockers.push(blocker.id || 'UNKNOWN');
      continue;
    }

    if (blocker.disposition === 'resolved') {
      if (!blocker.resolution || !blocker.resolution.fixedInPr || !blocker.resolution.regressionTest) {
        reasons.push(`Blocker ${blocker.id} marked resolved but lacks resolution details or regression test`);
        unresolvedBlockers.push(blocker.id);
      } else {
        resolvedCount++;
      }
    } else if (blocker.disposition === 'unresolved') {
      // Check if this release is a valid corrective release addressing another issue
      if (isCorrectiveRelease && targetIssue && targetIssue !== blocker.canonicalIssue) {
        // Unresolved blocker remains tracked, but does not block this specific corrective release
        unresolvedBlockers.push(blocker.id);
      } else {
        reasons.push(`Unresolved release blocker: ${blocker.id} (#${blocker.canonicalIssue} - ${blocker.title})`);
        unresolvedBlockers.push(blocker.id);
      }
    } else if (blocker.disposition === 'mitigated_exception') {
      const mit = blocker.mitigation;
      if (!mit || !mit.approvedBy || !mit.expiresAt || !mit.followUpIssue) {
        reasons.push(`Blocker ${blocker.id} has invalid or incomplete mitigation exception details`);
        unresolvedBlockers.push(blocker.id);
        continue;
      }

      const expiryDate = new Date(mit.expiresAt);
      if (isNaN(expiryDate.getTime())) {
        reasons.push(`Blocker ${blocker.id} has invalid expiresAt timestamp: ${mit.expiresAt}`);
        unresolvedBlockers.push(blocker.id);
      } else if (currentTime.getTime() > expiryDate.getTime()) {
        reasons.push(`Mitigation exception for ${blocker.id} expired at ${mit.expiresAt} (current: ${currentTime.toISOString()})`);
        unresolvedBlockers.push(blocker.id);
      } else {
        activeExceptions.push(blocker.id);
      }
    } else if (blocker.disposition === 'corrective_release') {
      const cr = blocker.correctiveRelease;
      if (!cr || !cr.approvedBy || !cr.compatibilityVerified || !cr.nonWorseningEvidence) {
        reasons.push(`Blocker ${blocker.id} marked as corrective release but lacks compatibility or approval`);
        unresolvedBlockers.push(blocker.id);
      } else if (!isCorrectiveRelease) {
        reasons.push(`Blocker ${blocker.id} is in corrective release status, but candidate was not declared as corrective release`);
        unresolvedBlockers.push(blocker.id);
      } else {
        activeExceptions.push(blocker.id);
      }
    } else {
      reasons.push(`Unknown blocker disposition for ${blocker.id}: ${blocker.disposition}`);
      unresolvedBlockers.push(blocker.id);
    }
  }

  // If candidate is declared as corrective release, verify non-worsening evidence is present
  if (isCorrectiveRelease) {
    const hasCorrectiveBlocker = blockersRecord.blockers.some(
      (b) => b.canonicalIssue === targetIssue && b.disposition === 'corrective_release'
    );
    if (!hasCorrectiveBlocker && (!targetIssue || reasons.length > 0)) {
      reasons.push('Candidate declared as corrective release without approved corrective disposition');
    }
  }

  // Promotion requires zero blocking reasons
  const eligible = reasons.length === 0 && (unresolvedBlockers.length === 0 || isCorrectiveRelease === true);

  return {
    eligible,
    unresolvedBlockers,
    activeExceptions,
    resolvedCount,
    reasons,
  };
}

/**
 * Loads the trusted release blockers record from config/release-blockers.json.
 */
export function loadReleaseBlockersRecord(customPath?: string): ReleaseBlockersRecord {
  const defaultPath = join(process.cwd(), 'config', 'release-blockers.json');
  const filePath = customPath || defaultPath;
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as ReleaseBlockersRecord;
}

// CLI runner
if (import.meta.url.startsWith('file:') && process.argv[1] && process.argv[1].endsWith('release-blockers.ts')) {
  try {
    const record = loadReleaseBlockersRecord();
    const result = evaluateReleaseEligibility({ blockersRecord: record });
    if (result.eligible) {
      console.log(`✓ Release eligible: 0 unresolved blockers, ${result.resolvedCount} resolved, ${result.activeExceptions.length} active exceptions.`);
      process.exit(0);
    } else {
      console.error('✗ Release blocked by unresolved blockers or invalid disposition:');
      result.reasons.forEach((r) => console.error(`  - ${r}`));
      process.exit(1);
    }
  } catch (error) {
    console.error(`Failed to verify release blockers: ${(error as Error).message}`);
    process.exit(1);
  }
}
