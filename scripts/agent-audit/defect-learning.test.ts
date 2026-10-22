import { describe, expect, it } from 'vitest';
import {
  historicalDefectLearningExamples,
  type DefectLearningRecord,
  validateDefectLearningRecord,
} from './defect-learning';

describe('defect learning closure contract validation', () => {
  it('validates all representative historical defect examples', () => {
    expect(historicalDefectLearningExamples).toHaveLength(5);

    for (const example of historicalDefectLearningExamples) {
      const result = validateDefectLearningRecord(example);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it('demonstrates escape classification across historical defect classes', () => {
    const classifications = historicalDefectLearningExamples.map((ex) => ex.escapeClassification);
    expect(classifications).toContain('missing_scenario');
    expect(classifications).toContain('incorrect_expected_contract');
    expect(classifications).toContain('over_mocked_collaborator');
    expect(classifications).toContain('wrong_test_level');
  });

  it('rejects records with missing or overly verbose root causes', () => {
    const record: DefectLearningRecord = {
      issue: 123,
      rootCause: '', // missing
      escapeClassification: 'missing_scenario',
      regressionEvidence: {
        testPath: 'src/test.ts',
        level: 'unit',
        observableBehavior: 'Observable recovery',
      },
      siblingScan: {
        pathsSearched: ['src/other.ts'],
        sameClassFoundElsewhere: false,
      },
    };

    const emptyResult = validateDefectLearningRecord(record);
    expect(emptyResult.valid).toBe(false);
    expect(emptyResult.errors).toContain('Root cause must be provided');

    // Overly verbose (multi-paragraph or multi-sentence essay)
    record.rootCause = 'First sentence explaining bug. Second sentence adding more detail. Third sentence continuing on. Fourth sentence never ending. ' + 'extra '.repeat(50);
    const verboseResult = validateDefectLearningRecord(record);
    expect(verboseResult.valid).toBe(false);
    expect(verboseResult.errors.some((e) => e.includes('concise'))).toBe(true);
  });

  it('rejects records that claim "tests pass" without describing observable behavior', () => {
    const record: DefectLearningRecord = {
      issue: 123,
      rootCause: 'Single sentence root cause.',
      escapeClassification: 'missing_scenario',
      regressionEvidence: {
        testPath: 'src/test.ts',
        level: 'unit',
        observableBehavior: 'tests pass', // not observable behavior description!
      },
      siblingScan: {
        pathsSearched: ['src/other.ts'],
        sameClassFoundElsewhere: false,
      },
    };

    // The validator enforces meaningful descriptions
    record.regressionEvidence.observableBehavior = 'tests ok';
    const result = validateDefectLearningRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('concrete failure/recovery behavior'))).toBe(true);
  });

  it('rejects sibling scan that omits searched paths or omits follow-up reference when found elsewhere', () => {
    const record: DefectLearningRecord = {
      issue: 123,
      rootCause: 'Single sentence root cause.',
      escapeClassification: 'missing_scenario',
      regressionEvidence: {
        testPath: 'src/test.ts',
        level: 'unit',
        observableBehavior: 'Catches quota denial and retains memory cache',
      },
      siblingScan: {
        pathsSearched: [], // empty!
        sameClassFoundElsewhere: false,
      },
    };

    const emptyPathsResult = validateDefectLearningRecord(record);
    expect(emptyPathsResult.valid).toBe(false);
    expect(emptyPathsResult.errors.some((e) => e.includes('at least one directly related path'))).toBe(true);

    record.siblingScan.pathsSearched = ['src/collaborator.ts'];
    record.siblingScan.sameClassFoundElsewhere = true;
    record.siblingScan.followUpIssueOrRef = undefined; // missing required follow-up!

    const missingFollowUpResult = validateDefectLearningRecord(record);
    expect(missingFollowUpResult.valid).toBe(false);
    expect(missingFollowUpResult.errors.some((e) => e.includes('follow-up issue or reference must be recorded'))).toBe(true);
  });
});
