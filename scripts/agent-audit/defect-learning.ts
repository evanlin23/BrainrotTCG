export type EscapeClassification =
  | 'missing_scenario'
  | 'incorrect_expected_contract'
  | 'over_mocked_collaborator'
  | 'wrong_test_level'
  | 'stale_uninspected_evidence'
  | 'missing_release_decision';

export interface DefectLearningRecord {
  issue: number;
  rootCause: string;
  escapeClassification: EscapeClassification;
  regressionEvidence: {
    testPath: string;
    level: 'unit' | 'integration' | 'browser_spec';
    observableBehavior: string;
  };
  siblingScan: {
    pathsSearched: string[];
    sameClassFoundElsewhere: boolean;
    followUpIssueOrRef?: string;
  };
  durablePrevention?: {
    type: 'architecture_guard' | 'validation_boundary' | 'ci_fixture' | 'type_system';
    target: string;
  };
}

export interface DefectLearningValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validates that a defect learning record adheres to the closure contract:
 * - Single-sentence root cause
 * - Valid escape classification
 * - Observable regression evidence (lowest useful test level)
 * - Sibling path search documented (with follow-up reference if found elsewhere)
 */
export function validateDefectLearningRecord(record: DefectLearningRecord): DefectLearningValidation {
  const errors: string[] = [];

  if (!record.issue || typeof record.issue !== 'number') {
    errors.push('Issue number must be a valid positive integer');
  }

  if (!record.rootCause || typeof record.rootCause !== 'string') {
    errors.push('Root cause must be provided');
  } else {
    const trimmed = record.rootCause.trim();
    if (trimmed.length > 250) {
      errors.push('Root cause must be concise (at most 250 characters, one sentence)');
    }
    if ((trimmed.match(/\./g) || []).length > 2) {
      errors.push('Root cause should be a single clear explanatory sentence');
    }
  }

  const validClassifications: EscapeClassification[] = [
    'missing_scenario',
    'incorrect_expected_contract',
    'over_mocked_collaborator',
    'wrong_test_level',
    'stale_uninspected_evidence',
    'missing_release_decision',
  ];
  if (!validClassifications.includes(record.escapeClassification)) {
    errors.push(`Invalid escape classification: ${record.escapeClassification}`);
  }

  if (!record.regressionEvidence) {
    errors.push('Regression evidence must be provided');
  } else {
    if (!record.regressionEvidence.testPath) {
      errors.push('Regression test path must be specified');
    }
    if (!['unit', 'integration', 'browser_spec'].includes(record.regressionEvidence.level)) {
      errors.push('Regression test level must be unit, integration, or browser_spec');
    }
    if (!record.regressionEvidence.observableBehavior || record.regressionEvidence.observableBehavior.length < 10) {
      errors.push('Observable regression behavior must describe concrete failure/recovery behavior, not merely "tests pass"');
    }
  }

  if (!record.siblingScan) {
    errors.push('Sibling scan must be documented');
  } else {
    if (!Array.isArray(record.siblingScan.pathsSearched) || record.siblingScan.pathsSearched.length === 0) {
      errors.push('Sibling scan must list at least one directly related path searched for the same failure class');
    }
    if (record.siblingScan.sameClassFoundElsewhere && !record.siblingScan.followUpIssueOrRef) {
      errors.push('When the same failure class is found elsewhere, a follow-up issue or reference must be recorded');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Representative historical defect learning records demonstrating the closure procedure
 * across different failure classes from repo audits.
 */
export const historicalDefectLearningExamples: DefectLearningRecord[] = [
  {
    issue: 695,
    rootCause: 'localStorage.removeItem during reopen cache timer flush threw on storage quota denial without try/catch containment.',
    escapeClassification: 'missing_scenario',
    regressionEvidence: {
      testPath: 'src/game/reopenCache.test.ts',
      level: 'unit',
      observableBehavior: 'Verifies flush() catches removal denial and retains bounded memory cache when setItem or removeItem fails.',
    },
    siblingScan: {
      pathsSearched: ['src/game/save.ts', 'src/game/move.ts', 'src/utils/settings.ts'],
      sameClassFoundElsewhere: false,
    },
    durablePrevention: {
      type: 'validation_boundary',
      target: 'src/game/reopenCache.ts',
    },
  },
  {
    issue: 694,
    rootCause: 'Proof verification fixtures conflated operational storage/network inability with forged proofs by asserting generic Error.',
    escapeClassification: 'incorrect_expected_contract',
    regressionEvidence: {
      testPath: 'scripts/fixtures/hof/adapters.ts',
      level: 'unit',
      observableBehavior: 'Asserts error taxonomy cleanly distinguishes operational refusal from cryptographic verification failure.',
    },
    siblingScan: {
      pathsSearched: ['src/engine/verify.ts', 'scripts/hall-of-fame.ts'],
      sameClassFoundElsewhere: false,
    },
    durablePrevention: {
      type: 'type_system',
      target: 'ProofVerificationResult',
    },
  },
  {
    issue: 647,
    rootCause: 'Settings save import accessed properties on untrusted parsed input before executing the schema validation helper.',
    escapeClassification: 'over_mocked_collaborator',
    regressionEvidence: {
      testPath: 'src/utils/settings.test.ts',
      level: 'unit',
      observableBehavior: 'Rejects null, primitive, and non-object inputs at entry before any property access occurs.',
    },
    siblingScan: {
      pathsSearched: ['src/game/save.ts', 'src/game/historyMigration.ts'],
      sameClassFoundElsewhere: true,
      followUpIssueOrRef: '#668',
    },
    durablePrevention: {
      type: 'validation_boundary',
      target: 'src/utils/settings.ts isSavePayloadObject guard',
    },
  },
  {
    issue: 660,
    rootCause: 'Legacy save migration was tested only via mounted React helper, omitting the real pre-React window entry initialization sequence.',
    escapeClassification: 'wrong_test_level',
    regressionEvidence: {
      testPath: 'src/test/collectionRecovery.integration.test.ts',
      level: 'integration',
      observableBehavior: 'Tests end-to-end recovery sequence starting from raw unmigrated localStorage keys before UI mount.',
    },
    siblingScan: {
      pathsSearched: ['src/main.tsx', 'src/game/historyMigration.ts'],
      sameClassFoundElsewhere: false,
    },
    durablePrevention: {
      type: 'ci_fixture',
      target: 'src/test/collectionRecovery.integration.test.ts',
    },
  },
  {
    issue: 693,
    rootCause: 'Profile processing accepted unbounded ticket counts and pack metrics from untrusted inputs without validation ceilings.',
    escapeClassification: 'missing_scenario',
    regressionEvidence: {
      testPath: 'src/game/profile.test.ts',
      level: 'unit',
      observableBehavior: 'Rejects or clamps excessively large counter values that exceed maximum plausible thresholds.',
    },
    siblingScan: {
      pathsSearched: ['src/game/progression.ts', 'src/game/deck.ts'],
      sameClassFoundElsewhere: false,
    },
    durablePrevention: {
      type: 'validation_boundary',
      target: 'src/game/profile.ts bounds helper',
    },
  },
];
