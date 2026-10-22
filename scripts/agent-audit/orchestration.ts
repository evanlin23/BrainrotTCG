export const STATE_BUDGET = {
  maxLines: 80,
  maxChars: 3600,
  maxLineChars: 240,
} as const;

export type IntegrityStatus = 'ok' | 'non_blocking_overflow' | 'critical_overflow' | 'missing';

export interface StateProjectionResult {
  projection: string;
  linesShown: number;
  charsShown: number;
  totalLines: number;
  totalChars: number;
  holdsTracked: number;
  truncatedLinesCount: number;
  status: IntegrityStatus;
  allowsMerge: boolean;
  message: string;
  sourceIssue?: string;
  gitRev?: string;
}

export interface ProjectOptions {
  maxLines?: number;
  maxChars?: number;
  maxLineChars?: number;
}

// Top-level keys of the ledger format in .claude/skills/work/SKILL.md, optionally with a note
// such as `holds (fix first, then merge):`. Keep in sync with
// .claude/hooks/orient.mjs, which repeats this parser (a parity test checks they agree).
// Only these keys start a section, so a hold whose text contains a colon stays a hold: every
// non-blank line between `holds:` and the next known key counts as a hold (fail closed).
const LEDGER_KEY = /^(ledger issue|source|authority|holds|order|done|needs owner|current|blockers)(?:\s*\([^)]*\))?\s*:(.*)$/i;
const RUN_HEADER = /^#\s+run\b/i;

/**
 * Projects local state (.claude/state/NOW.md) within a strict character and line budget.
 *
 * Invariants:
 * 1. Output is strictly bounded by maxLines and maxChars.
 * 2. Individual lines exceeding maxLineChars are truncated with an explicit marker.
 * 3. Never truncates a blocking hold into apparent permission: if any hold or authority
 *    entry is truncated or extends past the display boundary, status is critical_overflow
 *    and allowsMerge is set to false (MERGE/CLOSE/DELETE NOTHING until reconciled).
 */
export function projectState(content: string, options: ProjectOptions = {}): StateProjectionResult {
  const maxLines = options.maxLines ?? STATE_BUDGET.maxLines;
  const maxChars = options.maxChars ?? STATE_BUDGET.maxChars;
  const maxLineChars = options.maxLineChars ?? STATE_BUDGET.maxLineChars;

  const rawLines = content.split('\n');
  const totalLines = rawLines.length;
  const totalChars = content.length;

  let sourceIssue: string | undefined;
  let currentSection = '';
  const holdEntries: Array<{ lineIndex: number; text: string }> = [];
  const authorityEntries: Array<{ lineIndex: number; text: string }> = [];
  const holdHeaders: number[] = [];
  const authorityHeaders: number[] = [];

  for (let index = 0; index < rawLines.length; index++) {
    const trimmed = rawLines[index].trim();
    const keyMatch = trimmed.match(LEDGER_KEY);
    if (keyMatch || RUN_HEADER.test(trimmed)) {
      currentSection = keyMatch ? keyMatch[1].toLowerCase().replace(/\s+/g, ' ') : 'run';
      const inline = keyMatch ? keyMatch[2].trim() : '';
      if (currentSection === 'ledger issue') {
        const issue = inline.match(/^#?([0-9]+)/);
        if (issue) sourceIssue = `#${issue[1]}`;
      } else if (currentSection === 'holds') {
        holdHeaders.push(index);
        if (inline && !/^none\.?$/i.test(inline)) holdEntries.push({ lineIndex: index, text: inline });
      } else if (currentSection === 'authority') {
        authorityHeaders.push(index);
        if (inline) authorityEntries.push({ lineIndex: index, text: inline });
      }
      continue;
    }

    if (currentSection === 'holds') {
      if (trimmed) holdEntries.push({ lineIndex: index, text: trimmed });
    } else if (currentSection === 'authority') {
      if (trimmed) authorityEntries.push({ lineIndex: index, text: trimmed });
    } else if (/\b(must not merge|merge hold|held until|blocking hold)\b/i.test(trimmed)) {
      // Hold placed outside the holds block
      holdEntries.push({ lineIndex: index, text: trimmed });
    }
  }

  // Build the bounded projection
  const projectedLines: string[] = [];
  let currentChars = 0;
  let truncatedLinesCount = 0;
  let authorityTruncated = false;
  let holdTruncated = false;
  let cutOffLineIndex = totalLines;

  for (let index = 0; index < rawLines.length; index++) {
    if (projectedLines.length >= maxLines) {
      cutOffLineIndex = index;
      break;
    }

    let line = rawLines[index];
    const isHoldLine = holdEntries.some((entry) => entry.lineIndex === index);
    const isAuthorityLine = authorityEntries.some((entry) => entry.lineIndex === index);

    if (line.length > maxLineChars) {
      line = line.slice(0, maxLineChars) + '... [line truncated]';
      truncatedLinesCount++;
      if (isHoldLine) holdTruncated = true;
      if (isAuthorityLine) authorityTruncated = true;
    }

    const addedChars = line.length + (projectedLines.length > 0 ? 1 : 0);
    if (currentChars + addedChars > maxChars) {
      cutOffLineIndex = index;
      break;
    }

    projectedLines.push(line);
    currentChars += addedChars;
  }

  // Check if any hold or authority occurred at or past the boundary
  const holdsPastBoundary = holdEntries.filter((entry) => entry.lineIndex >= cutOffLineIndex);
  const authorityPastBoundary = authorityEntries.filter((entry) => entry.lineIndex >= cutOffLineIndex);
  const holdHeaderPastBoundary = holdHeaders.some((index) => index >= cutOffLineIndex);
  const authorityHeaderPastBoundary = authorityHeaders.some((index) => index >= cutOffLineIndex);

  let status: IntegrityStatus;
  let allowsMerge: boolean;
  let message: string;

  const holdsIncomplete = holdTruncated || holdsPastBoundary.length > 0 || holdHeaderPastBoundary;
  const authorityIncomplete = authorityTruncated || authorityPastBoundary.length > 0 || authorityHeaderPastBoundary;

  if (authorityEntries.length === 0 && holdEntries.length === 0 && totalLines > 5) {
    status = 'critical_overflow';
    allowsMerge = false;
    message = 'CRITICAL: Authority and holds missing from state. MERGE/CLOSE/DELETE NOTHING until reconciled.';
  } else if (holdHeaders.length === 0 || authorityHeaders.length === 0) {
    status = 'critical_overflow';
    allowsMerge = false;
    message = `CRITICAL: ${holdHeaders.length === 0 ? 'holds:' : 'authority:'} section missing from state. MERGE/CLOSE/DELETE NOTHING until reconciled.`;
  } else if (holdsIncomplete || authorityIncomplete) {
    status = 'critical_overflow';
    allowsMerge = false;
    const reasons: string[] = [];
    if (holdTruncated) reasons.push('hold line truncated');
    if (holdsPastBoundary.length > 0) reasons.push(`${holdsPastBoundary.length} hold(s) past display boundary`);
    if (holdHeaderPastBoundary) reasons.push('holds block past display boundary');
    if (authorityTruncated) reasons.push('authority line truncated');
    if (authorityPastBoundary.length > 0 || authorityHeaderPastBoundary) reasons.push('authority past display boundary');
    message = `CRITICAL OVERFLOW: Authority or holds incomplete (${reasons.join(', ')}). MERGE/CLOSE/DELETE NOTHING until reconciled.`;
  } else if (cutOffLineIndex < totalLines || currentChars < totalChars || truncatedLinesCount > 0) {
    status = 'non_blocking_overflow';
    allowsMerge = true;
    message = `WARNING: State truncated to fit budget (${totalLines} lines, ${totalChars} chars -> ${projectedLines.length} lines, ${currentChars} chars shown). Authority and holds intact. Trim history/done before other work.`;
  } else {
    status = 'ok';
    allowsMerge = true;
    message = `OK (compact state: ${projectedLines.length} lines, ${currentChars} chars; ${holdEntries.length} hold(s) tracked; authority loaded).`;
  }

  return {
    projection: projectedLines.join('\n'),
    linesShown: projectedLines.length,
    charsShown: currentChars,
    totalLines,
    totalChars,
    holdsTracked: holdEntries.length,
    truncatedLinesCount,
    status,
    allowsMerge,
    message,
    sourceIssue,
  };
}

export interface StartupOutputOptions {
  branch?: string;
  commit?: string;
  uncommitted?: string[];
  statePath?: string;
  stateContent: string | null;
  budget?: ProjectOptions;
}

/**
 * Formats the complete startup projection printed on SessionStart.
 */
export function formatStartupOutput(options: StartupOutputOptions): string {
  const branch = options.branch || '?';
  const commit = options.commit || '?';
  const statePath = options.statePath || '.claude/state/NOW.md';
  const lines: string[] = [`Branch: ${branch} at ${commit}`];

  if (options.uncommitted && options.uncommitted.length > 0) {
    lines.push('Uncommitted:');
    options.uncommitted.slice(0, 15).forEach((item) => lines.push(item));
  }

  if (options.stateContent === null) {
    lines.push(`No ${statePath} here. Only /work uses it; /work rebuilds it from the "Claude work ledger" issue and merges nothing until it does.`);
    lines.push('--- Status: MISSING (merge/close/delete forbidden until loaded from ledger issue) ---');
    return lines.join('\n');
  }

  const projection = projectState(options.stateContent, options.budget);
  const sourceLabel = projection.sourceIssue ? `source: ${projection.sourceIssue}, ` : '';
  lines.push(`--- ${statePath} (${sourceLabel}git: ${commit}) ---`);
  lines.push(projection.projection);
  lines.push(`--- Status: ${projection.message} ---`);

  return lines.join('\n');
}

/**
 * Verification fact cache keyed by exact SHA and execution parameters.
 * Guarantees that earlier-head green status is never reused once relevant
 * changes or head SHAs differ.
 */
export interface VerificationFact {
  sha: string;
  command: string;
  configHash?: string;
  envHash?: string;
  status: 'pass' | 'fail';
  outputSnippet?: string;
  timestamp: number;
}

export class VerificationCache {
  private facts = new Map<string, VerificationFact>();

  private makeKey(sha: string, command: string, configHash = '', envHash = ''): string {
    return `${sha}::${command}::${configHash}::${envHash}`;
  }

  record(fact: Omit<VerificationFact, 'timestamp'>): void {
    const key = this.makeKey(fact.sha, fact.command, fact.configHash, fact.envHash);
    this.facts.set(key, { ...fact, timestamp: Date.now() });
  }

  lookup(sha: string, command: string, configHash = '', envHash = ''): VerificationFact | undefined {
    const key = this.makeKey(sha, command, configHash, envHash);
    return this.facts.get(key);
  }

  hasValidPass(sha: string, command: string, configHash = '', envHash = ''): boolean {
    const fact = this.lookup(sha, command, configHash, envHash);
    return fact !== undefined && fact.status === 'pass';
  }

  clear(): void {
    this.facts.clear();
  }
}

/**
 * Small structured task brief format.
 * Orchestrator receives short structured results (<=15 lines for implementer,
 * <=25 lines for reviewer), without full conversation or diff propagation.
 */
export interface TaskBrief {
  issue: number | string;
  outcome: string;
  acceptance: string[];
  relevantPaths: string[];
  prerequisites: string[];
  riskTier: 'standard' | 'high';
  modelTier: 'sonnet' | 'opus';
  head: string;
  requiredEvidence: string[];
  unresolvedFindings?: string[];
}

export function createTaskBrief(params: TaskBrief): string {
  const lines: string[] = [
    `# Task Brief: Issue #${params.issue}`,
    `outcome: ${params.outcome}`,
    `head: ${params.head}`,
    `risk: ${params.riskTier} (model: ${params.modelTier})`,
    'acceptance criteria:',
    ...params.acceptance.map((criterion) => `- ${criterion}`),
    'relevant paths:',
    ...params.relevantPaths.map((path) => `- ${path}`),
    'prerequisites:',
    ...(params.prerequisites.length ? params.prerequisites.map((item) => `- ${item}`) : ['- none']),
    'required evidence:',
    ...params.requiredEvidence.map((evidence) => `- ${evidence}`),
  ];

  if (params.unresolvedFindings && params.unresolvedFindings.length > 0) {
    lines.push('unresolved findings to address:');
    params.unresolvedFindings.forEach((finding) => lines.push(`- ${finding}`));
  }

  return lines.join('\n');
}

export interface ReviewerReport {
  verdict: 'approve' | 'changes-needed' | 'block';
  head: string;
  findings: Array<{ severity: 'blocking' | 'minor'; location: string; description: string }>;
  notChecked: string[];
  allowsMerge: boolean;
  reason?: string;
}

/**
 * Parses the reply format in .claude/agents/reviewer.md:
 *   verdict: approve | changes-needed | block
 *   head: <commit>
 *   findings (most severe first, at most 5):
 *   - [blocking|minor] path:line: what's wrong
 *   not checked: ...
 * Fails closed: an unreadable verdict is `block`, a head needs at least 7 hex characters and must
 * prefix the candidate head, a finding bullet without a readable severity counts as blocking, and
 * any blocking finding refuses the merge whatever the verdict says.
 */
export function parseReviewerReport(raw: string, currentHead: string): ReviewerReport {
  let verdict: ReviewerReport['verdict'] = 'block';
  let head = '';
  const findings: ReviewerReport['findings'] = [];
  const notChecked: string[] = [];
  let section: 'findings' | 'not checked' | '' = '';

  for (const line of raw.trim().split('\n')) {
    const trimmed = line.trim();
    const verdictMatch = trimmed.match(/^verdict\s*:\s*(approve|changes-needed|block)\b/i);
    const headMatch = trimmed.match(/^head\s*:\s*([0-9a-f]{7,40})\b/i);
    if (/^verdict\s*:/i.test(trimmed)) {
      section = '';
      verdict = verdictMatch ? (verdictMatch[1].toLowerCase() as ReviewerReport['verdict']) : 'block';
    } else if (/^head\s*:/i.test(trimmed)) {
      section = '';
      head = headMatch ? headMatch[1].toLowerCase() : '';
    } else if (/^findings\b/i.test(trimmed)) {
      section = 'findings';
    } else if (/^not checked\b/i.test(trimmed)) {
      section = 'not checked';
      const inline = trimmed.replace(/^not checked\s*:?/i, '').trim();
      if (inline) notChecked.push(inline);
    } else if (section === 'findings' && trimmed.startsWith('-')) {
      const match = trimmed.match(/^-\s*\[(blocking|minor)\]\s*(.*?):\s(.*)$/i);
      if (match) {
        findings.push({
          severity: match[1].toLowerCase() as 'blocking' | 'minor',
          location: match[2].trim(),
          description: match[3].trim(),
        });
      } else {
        findings.push({ severity: 'blocking', location: 'unknown', description: trimmed.slice(1).trim() });
      }
    } else if (section === 'not checked' && trimmed) {
      notChecked.push(trimmed.replace(/^-\s*/, ''));
    }
  }

  const hasBlockingFindings = findings.some((f) => f.severity === 'blocking');
  const headMatches = head.length >= 7 && currentHead.toLowerCase().startsWith(head);

  let reason: string | undefined;
  if (hasBlockingFindings) {
    reason = 'Review contains blocking findings';
  } else if (verdict !== 'approve') {
    reason = `Review verdict is ${verdict}`;
  } else if (!headMatches) {
    reason = `Reviewer head (${head || 'unspecified'}) does not match current candidate head (${currentHead})`;
  }

  return { verdict, head, findings, notChecked, allowsMerge: reason === undefined, reason };
}
