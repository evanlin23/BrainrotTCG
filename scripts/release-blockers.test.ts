import { describe, expect, it } from 'vitest';
import {
  evaluateReleaseEligibility,
  loadReleaseBlockersRecord,
  type ReleaseBlockersRecord,
} from './release-blockers';

describe('release blockers evaluation & promotion eligibility', () => {
  it('approves promotion for healthy repository record with all resolved blockers', () => {
    const record = loadReleaseBlockersRecord();
    const result = evaluateReleaseEligibility({ blockersRecord: record });

    expect(result.eligible).toBe(true);
    expect(result.unresolvedBlockers).toHaveLength(0);
    expect(result.resolvedCount).toBeGreaterThan(0);
    expect(result.reasons).toHaveLength(0);
  });

  it('fails closed when an unresolved blocker is present', () => {
    const record: ReleaseBlockersRecord = {
      version: 1,
      description: 'Test record with unresolved blocker',
      blockers: [
        {
          id: 'RB-999',
          canonicalIssue: 999,
          title: 'Persistent blank screen on initial load',
          category: 'startup_blank',
          severityRationale: 'App completely fails to initialize on webkit',
          owner: 'evanlin23',
          disposition: 'unresolved',
        },
      ],
    };

    const result = evaluateReleaseEligibility({ blockersRecord: record });
    expect(result.eligible).toBe(false);
    expect(result.unresolvedBlockers).toContain('RB-999');
    expect(result.reasons.some((r) => r.includes('Unresolved release blocker: RB-999'))).toBe(true);
  });

  it('fails closed when a blocker is marked resolved but lacks regression evidence', () => {
    const record: ReleaseBlockersRecord = {
      version: 1,
      description: 'Test record with incomplete resolution',
      blockers: [
        {
          id: 'RB-100',
          canonicalIssue: 100,
          title: 'Save loss on page refresh',
          category: 'save_loss',
          severityRationale: 'Saves dropped',
          owner: 'evanlin23',
          disposition: 'resolved',
          resolution: {
            fixedInPr: 0, // invalid
            regressionTest: '', // missing
            verifiedHead: '',
          },
        },
      ],
    };

    const result = evaluateReleaseEligibility({ blockersRecord: record });
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes('lacks resolution details'))).toBe(true);
  });

  it('permits promotion under an active, unexpired mitigation exception', () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(); // 7 days in future
    const record: ReleaseBlockersRecord = {
      version: 1,
      description: 'Test record with active exception',
      blockers: [
        {
          id: 'RB-200',
          canonicalIssue: 200,
          title: 'Secondary screen layout overflow on 320px viewport',
          category: 'inaccessible_core',
          severityRationale: 'Settings screen truncated on narrow legacy screen',
          owner: 'evanlin23',
          disposition: 'mitigated_exception',
          mitigation: {
            scope: 'Affects only 320px viewport in Settings; opening and sharing unaffected',
            rationale: 'Temporary CSS scroll fallback deployed while full flex refactor is underway',
            approvedBy: 'evanlin23',
            mitigationEvidence: 'Verified in tests/browser/settings.spec.ts',
            expiresAt: futureDate,
            followUpIssue: 205,
          },
        },
      ],
    };

    const result = evaluateReleaseEligibility({ blockersRecord: record });
    expect(result.eligible).toBe(true);
    expect(result.activeExceptions).toContain('RB-200');
    expect(result.reasons).toHaveLength(0);
  });

  it('fails closed when a mitigation exception has expired', () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // 1 day in past
    const record: ReleaseBlockersRecord = {
      version: 1,
      description: 'Test record with expired exception',
      blockers: [
        {
          id: 'RB-201',
          canonicalIssue: 201,
          title: 'Secondary screen layout overflow',
          category: 'inaccessible_core',
          severityRationale: 'Settings screen truncated',
          owner: 'evanlin23',
          disposition: 'mitigated_exception',
          mitigation: {
            scope: 'Settings screen',
            rationale: 'Temporary fallback',
            approvedBy: 'evanlin23',
            mitigationEvidence: 'Verified',
            expiresAt: pastDate,
            followUpIssue: 205,
          },
        },
      ],
    };

    const result = evaluateReleaseEligibility({ blockersRecord: record });
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes('expired'))).toBe(true);
  });

  it('allows a targeted corrective release to deploy safety fix while other tracked defects remain', () => {
    const record: ReleaseBlockersRecord = {
      version: 1,
      description: 'Corrective release scenario',
      blockers: [
        {
          id: 'RB-695',
          canonicalIssue: 695,
          title: 'Reopen cache cleanup throws on quota denial',
          category: 'save_loss',
          severityRationale: 'Timer throws unhandled exception on quota full',
          owner: 'evanlin23',
          disposition: 'corrective_release',
          correctiveRelease: {
            targetIssue: 695,
            nonWorseningEvidence: 'Verified reopenCache containment preserves existing save readers without side effects',
            compatibilityVerified: true,
            approvedBy: 'evanlin23',
          },
        },
        {
          id: 'RB-998',
          canonicalIssue: 998,
          title: 'Other surviving defect in backlog',
          category: 'broken_proof',
          severityRationale: 'Proof verification format deprecation',
          owner: 'evanlin23',
          disposition: 'unresolved',
        },
      ],
    };

    // Candidate targeting issue 695 declared as corrective release
    const result = evaluateReleaseEligibility({
      blockersRecord: record,
      isCorrectiveRelease: true,
      targetIssue: 695,
    });

    expect(result.eligible).toBe(true);
    expect(result.activeExceptions).toContain('RB-695');
  });

  it('refuses promotion when a corrective release lacks verified compatibility', () => {
    const record: ReleaseBlockersRecord = {
      version: 1,
      description: 'Invalid corrective release scenario',
      blockers: [
        {
          id: 'RB-695',
          canonicalIssue: 695,
          title: 'Reopen cache cleanup throws on quota denial',
          category: 'save_loss',
          severityRationale: 'Timer throws',
          owner: 'evanlin23',
          disposition: 'corrective_release',
          correctiveRelease: {
            targetIssue: 695,
            nonWorseningEvidence: 'Incomplete evidence',
            compatibilityVerified: false, // unverified compatibility!
            approvedBy: 'evanlin23',
          },
        },
      ],
    };

    const result = evaluateReleaseEligibility({
      blockersRecord: record,
      isCorrectiveRelease: true,
      targetIssue: 695,
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes('lacks compatibility'))).toBe(true);
  });

  it('fails closed when record is malformed or missing', () => {
    const result = evaluateReleaseEligibility({
      blockersRecord: null as unknown as ReleaseBlockersRecord,
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('Release blockers record is missing or malformed');
  });
});
