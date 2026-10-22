import { describe, expect, it } from 'vitest';
import {
  type StructuredReviewReport,
  validateReviewReport,
} from './review-contracts';

const candidateHead = '4a8b7c6d5e';

describe('proportional review contracts: high-risk tier', () => {
  it('approves a high-risk change with independent counterexample, mock fidelity, and entry verification', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '4a8b7c6d5e',
      riskTier: 'high_risk',
      findings: [
        { severity: 'minor', location: 'src/game/save.ts:42', description: 'Consider explicit const name' },
      ],
      notChecked: ['playwright performance benchmarks in headless chrome'],
      evidence: {
        highRisk: {
          counterexampleDerived: true,
          mockFidelityVerified: true,
          entryPointVerified: true,
        },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(true);
    expect(result.verdict).toBe('approve');
    expect(result.reasons).toEqual([]);
  });

  it('rejects high-risk approval when independent counterexample is not derived', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '4a8b7c6d5e',
      riskTier: 'high_risk',
      findings: [],
      notChecked: [],
      evidence: {
        highRisk: {
          counterexampleDerived: false, // author tests trusted blindly
          mockFidelityVerified: true,
          entryPointVerified: true,
        },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(false);
    expect(result.verdict).toBe('changes-needed');
    expect(result.reasons).toContain('High-risk review must derive at least one counterexample independently of author tests');
  });

  it('rejects high-risk approval when mock fidelity is unverified (escaped defect guard #694)', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '4a8b7c6d5e',
      riskTier: 'high_risk',
      findings: [],
      notChecked: [],
      evidence: {
        highRisk: {
          counterexampleDerived: true,
          mockFidelityVerified: false, // generic Error hides distinction between operational failure and bad proof
          entryPointVerified: true,
        },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(false);
    expect(result.reasons).toContain('High-risk review must verify mock fidelity preserves real error taxonomy and lifecycle');
  });

  it('rejects approval when unresolved correctness risk is placed in "not checked"', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '4a8b7c6d5e',
      riskTier: 'high_risk',
      findings: [],
      notChecked: ['storage save loss on concurrent write unverified'],
      evidence: {
        highRisk: {
          counterexampleDerived: true,
          mockFidelityVerified: true,
          entryPointVerified: true,
        },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(false);
    expect(result.reasons).toContain('Unresolved correctness risk listed in "not checked" cannot be approved without evidence');
  });
});

describe('proportional review contracts: visible-flow tier', () => {
  it('approves a visible-flow change with player job, declutter disposition, and complete states', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '4a8b7c6d5e',
      riskTier: 'visible_flow',
      findings: [],
      notChecked: ['iOS Safari voiceover (emulated via Playwright a11y tree)'],
      evidence: {
        visibleFlow: {
          playerJob: 'Claim and reveal daily ranking pack',
          primaryFact: 'Highest verified score of the day',
          nextAction: 'Tap open pack button',
          declutterAction: 'demote',
          statesInspected: ['empty', 'loading', 'error', 'narrow', 'keyboard'],
        },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(true);
    expect(result.verdict).toBe('approve');
  });

  it('rejects visible flow when empty/loading/error states are not inspected', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '4a8b7c6d5e',
      riskTier: 'visible_flow',
      findings: [],
      notChecked: [],
      evidence: {
        visibleFlow: {
          playerJob: 'View profile',
          primaryFact: 'Card count',
          nextAction: 'Share profile',
          declutterAction: 'keep',
          statesInspected: ['narrow'], // missing empty, loading, error!
        },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(false);
    expect(result.reasons.some((r) => r.includes('important states'))).toBe(true);
  });
});

describe('proportional review contracts: architecture tier', () => {
  it('approves an architecture change evaluating ownership, simpler alternatives, and lifetime', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '4a8b7c6d5e',
      riskTier: 'architecture',
      findings: [],
      notChecked: [],
      evidence: {
        architecture: {
          responsibilityOwnership: true,
          simplerAlternativesConsidered: true,
          resourceLifetimeSafe: true,
          untrustedDataBounded: true,
        },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(true);
    expect(result.verdict).toBe('approve');
  });

  it('rejects architecture change when untrusted data is not bounded', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '4a8b7c6d5e',
      riskTier: 'architecture',
      findings: [],
      notChecked: [],
      evidence: {
        architecture: {
          responsibilityOwnership: true,
          simplerAlternativesConsidered: true,
          resourceLifetimeSafe: true,
          untrustedDataBounded: false,
        },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(false);
    expect(result.reasons).toContain('Architecture review must verify untrusted data bounds');
  });
});

describe('proportional review contracts: routine-doc tier', () => {
  it('approves routine doc changes with link and formatting checks without heavy test gates', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '4a8b7c6d5e',
      riskTier: 'routine_doc',
      findings: [],
      notChecked: ['browser smoke test'],
      evidence: {
        routineDoc: {
          linksVerified: true,
          formattingChecked: true,
        },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(true);
    expect(result.verdict).toBe('approve');
  });
});

describe('proportional review contracts: common head & blocking invariants', () => {
  it('rejects approval when reviewed head does not match candidate head', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '9999999', // stale head!
      riskTier: 'routine_doc',
      findings: [],
      notChecked: [],
      evidence: {
        routineDoc: { linksVerified: true, formattingChecked: true },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(false);
    expect(result.reasons.some((r) => r.includes('does not match'))).toBe(true);
  });

  it('rejects approval when any blocking finding is present', () => {
    const report: StructuredReviewReport = {
      verdict: 'approve',
      head: '4a8b7c6d5e',
      riskTier: 'routine_doc',
      findings: [
        { severity: 'blocking', location: 'docs/test.md:10', description: 'Broken syntax' },
      ],
      notChecked: [],
      evidence: {
        routineDoc: { linksVerified: true, formattingChecked: true },
      },
    };

    const result = validateReviewReport(report, candidateHead);
    expect(result.allowsMerge).toBe(false);
    expect(result.reasons).toContain('Report contains blocking finding(s)');
  });
});
