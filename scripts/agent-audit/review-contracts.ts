export type RiskTier = 'routine_doc' | 'visible_flow' | 'architecture' | 'high_risk';

export type DeclutterAction = 'keep' | 'merge' | 'demote' | 'disclose' | 'remove';

export interface HighRiskEvidence {
  counterexampleDerived: boolean;
  mockFidelityVerified: boolean;
  entryPointVerified: boolean;
}

export interface VisibleFlowEvidence {
  playerJob: string;
  primaryFact: string;
  nextAction: string;
  declutterAction: DeclutterAction;
  statesInspected: Array<'empty' | 'loading' | 'error' | 'narrow' | 'large_text' | 'keyboard'>;
}

export interface ArchitectureEvidence {
  responsibilityOwnership: boolean;
  simplerAlternativesConsidered: boolean;
  resourceLifetimeSafe: boolean;
  untrustedDataBounded: boolean;
}

export interface RoutineDocEvidence {
  linksVerified: boolean;
  formattingChecked: boolean;
}

export interface StructuredReviewReport {
  verdict: 'approve' | 'changes-needed' | 'block';
  head: string;
  riskTier: RiskTier;
  findings: Array<{
    severity: 'blocking' | 'minor';
    location: string;
    description: string;
  }>;
  notChecked: string[];
  evidence?: {
    highRisk?: HighRiskEvidence;
    visibleFlow?: VisibleFlowEvidence;
    architecture?: ArchitectureEvidence;
    routineDoc?: RoutineDocEvidence;
  };
}

export interface ReviewValidationResult {
  allowsMerge: boolean;
  verdict: 'approve' | 'changes-needed' | 'block';
  reasons: string[];
}

/**
 * Validates an independent review against risk-proportional evidence requirements
 * and escaped-defect invariants.
 */
export function validateReviewReport(
  report: StructuredReviewReport,
  candidateHead: string
): ReviewValidationResult {
  const reasons: string[] = [];

  // Head commitment invariant
  if (!report.head || !candidateHead.startsWith(report.head)) {
    reasons.push(`Reviewed head (${report.head || 'none'}) does not match current candidate head (${candidateHead})`);
  }

  // Blocking findings invariant
  const hasBlockingFinding = report.findings.some((f) => f.severity === 'blocking');
  if (hasBlockingFinding) {
    reasons.push('Report contains blocking finding(s)');
  }

  // Verdict invariant
  if (report.verdict !== 'approve') {
    reasons.push(`Review verdict is ${report.verdict}`);
  }

  // 'not checked' invariant: cannot approve unresolved correctness risks
  const correctnessRiskPatterns = [
    /correctness/i,
    /storage/i,
    /save loss/i,
    /proof/i,
    /migration/i,
    /unverified/i,
    /mock error/i,
    /leak/i,
  ];
  const unresolvedRiskInNotChecked = report.notChecked.some((item) =>
    correctnessRiskPatterns.some((pattern) => pattern.test(item))
  );
  if (unresolvedRiskInNotChecked && report.verdict === 'approve') {
    reasons.push('Unresolved correctness risk listed in "not checked" cannot be approved without evidence');
  }

  // Proportional evidence checks by tier
  if (report.riskTier === 'high_risk') {
    const ev = report.evidence?.highRisk;
    if (!ev) {
      reasons.push('High-risk change missing highRisk evidence structure');
    } else {
      if (!ev.counterexampleDerived) {
        reasons.push('High-risk review must derive at least one counterexample independently of author tests');
      }
      if (!ev.mockFidelityVerified) {
        reasons.push('High-risk review must verify mock fidelity preserves real error taxonomy and lifecycle');
      }
      if (!ev.entryPointVerified) {
        reasons.push('High-risk review must verify real startup/entry behavior');
      }
    }
  } else if (report.riskTier === 'visible_flow') {
    const ev = report.evidence?.visibleFlow;
    if (!ev) {
      reasons.push('Visible flow change missing visibleFlow evidence structure');
    } else {
      if (!ev.playerJob || !ev.primaryFact || !ev.nextAction) {
        reasons.push('Visible flow review must state screen player job, primary fact, and next action');
      }
      if (!ev.declutterAction) {
        reasons.push('Visible flow review must evaluate material visible repetition (keep/merge/demote/disclose/remove)');
      }
      const requiredStates: Array<'empty' | 'loading' | 'error'> = ['empty', 'loading', 'error'];
      const missingStates = requiredStates.filter((s) => !ev.statesInspected.includes(s));
      if (missingStates.length > 0) {
        reasons.push(`Visible flow review must inspect important states (${missingStates.join(', ')} missing)`);
      }
    }
  } else if (report.riskTier === 'architecture') {
    const ev = report.evidence?.architecture;
    if (!ev) {
      reasons.push('Architecture change missing architecture evidence structure');
    } else {
      if (!ev.responsibilityOwnership) reasons.push('Architecture review must verify responsibility ownership');
      if (!ev.simplerAlternativesConsidered) reasons.push('Architecture review must evaluate simpler existing alternatives');
      if (!ev.resourceLifetimeSafe) reasons.push('Architecture review must verify async/resource lifetime safety');
      if (!ev.untrustedDataBounded) reasons.push('Architecture review must verify untrusted data bounds');
    }
  } else if (report.riskTier === 'routine_doc') {
    const ev = report.evidence?.routineDoc;
    if (!ev) {
      reasons.push('Routine doc change missing routineDoc evidence structure');
    } else {
      if (!ev.linksVerified) reasons.push('Doc change must verify local links');
      if (!ev.formattingChecked) reasons.push('Doc change must check markdown formatting and git diff check');
    }
  }

  const allowsMerge = reasons.length === 0;
  const verdict = allowsMerge ? 'approve' : (report.verdict === 'block' ? 'block' : 'changes-needed');

  return {
    allowsMerge,
    verdict,
    reasons,
  };
}
