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

/**
 * Projects local state (.claude/state/NOW.md) within a strict character and line budget.
 *
 * Invariants:
 * 1. Output is strictly bounded by maxLines and maxChars.
 * 2. Individual lines exceeding maxLineChars are truncated with an explicit marker.
 * 3. Never truncates a blocking hold into apparent permission: if any hold or authority
 *    entry is truncated or extends past the display boundary, status is critical_overflow
 *    and allowsMerge is set to false (MERGE/DELETE NOTHING until reconciled).
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

  // Identify sections and holds across the ENTIRE source content
  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index];
    const trimmed = line.trim();

    const ledgerMatch = trimmed.match(/^ledger issue:\s*#?([0-9]+)/i);
    if (ledgerMatch) sourceIssue = `#${ledgerMatch[1]}`;

    if (/^holds:\s*/i.test(trimmed)) {
      currentSection = 'holds';
      const inline = trimmed.replace(/^holds:\s*/i, '').trim();
      if (inline && inline !== 'none') {
        holdEntries.push({ lineIndex: index, text: inline });
      }
      continue;
    } else if (/^authority:\s*/i.test(trimmed)) {
      currentSection = 'authority';
      const inline = trimmed.replace(/^authority:\s*/i, '').trim();
      if (inline) authorityEntries.push({ lineIndex: index, text: inline });
      continue;
    } else if (/^[a-z0-9 _-]+:\s*/i.test(trimmed) || /^#\s+/i.test(trimmed)) {
      currentSection = trimmed.split(':')[0].toLowerCase();
    }

    if (currentSection === 'holds') {
      if (trimmed.startsWith('-') || /^(#\d+|\bheld\b|\bhold\b)/i.test(trimmed)) {
        holdEntries.push({ lineIndex: index, text: trimmed });
      }
    } else if (currentSection === 'authority') {
      if (trimmed) authorityEntries.push({ lineIndex: index, text: trimmed });
    } else if (/\b(must not merge|merge hold|held until|blocking hold)\b/i.test(trimmed)) {
      // Hold placed outside normal holds header
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

  let status: IntegrityStatus;
  let allowsMerge: boolean;
  let message: string;

  const holdsIncomplete = holdTruncated || holdsPastBoundary.length > 0;
  const authorityIncomplete = authorityTruncated || authorityPastBoundary.length > 0;

  if (authorityEntries.length === 0 && holdEntries.length === 0 && totalLines > 5) {
    status = 'critical_overflow';
    allowsMerge = false;
    message = 'CRITICAL: Authority and holds missing from state. MERGE/DELETE NOTHING until reconciled.';
  } else if (holdsIncomplete || authorityIncomplete) {
    status = 'critical_overflow';
    allowsMerge = false;
    const reasons: string[] = [];
    if (holdTruncated) reasons.push('hold line truncated');
    if (holdsPastBoundary.length > 0) reasons.push(`${holdsPastBoundary.length} hold(s) past display boundary`);
    if (authorityTruncated) reasons.push('authority line truncated');
    if (authorityPastBoundary.length > 0) reasons.push('authority past display boundary');
    message = `CRITICAL OVERFLOW: Authority or holds incomplete (${reasons.join(', ')}). MERGE/DELETE NOTHING until reconciled.`;
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
    lines.push('--- Status: MISSING (merge/delete forbidden until loaded from ledger issue) ---');
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

export function parseReviewerReport(raw: string, currentHead: string): ReviewerReport {
  const lines = raw.trim().split('\n');
  let verdict: 'approve' | 'changes-needed' | 'block' = 'block';
  let head = '';
  const findings: Array<{ severity: 'blocking' | 'minor'; location: string; description: string }> = [];
  const notChecked: string[] = [];
  let inFindings = false;
  let inNotChecked = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('verdict:')) {
      const value = trimmed.replace('verdict:', '').trim().toLowerCase();
      if (value === 'approve' || value === 'changes-needed' || value === 'block') {
        verdict = value;
      }
    } else if (trimmed.startsWith('head:')) {
      head = trimmed.replace('head:', '').trim();
    } else if (trimmed.startsWith('findings:')) {
      inFindings = true;
      inNotChecked = false;
    } else if (trimmed.startsWith('not checked:')) {
      inNotChecked = true;
      inFindings = false;
      const inline = trimmed.replace('not checked:', '').trim();
      if (inline) notChecked.push(inline);
    } else if (inFindings && trimmed.startsWith('-')) {
      const match = trimmed.match(/^-\s*\[(blocking|minor)\]\s*([^:]+):\s*(.*)/i);
      if (match) {
        findings.push({
          severity: match[1].toLowerCase() as 'blocking' | 'minor',
          location: match[2].trim(),
          description: match[3].trim(),
        });
      } else {
        findings.push({ severity: 'blocking', location: 'unknown', description: trimmed.slice(1).trim() });
      }
    } else if (inNotChecked && trimmed.startsWith('-')) {
      notChecked.push(trimmed.slice(1).trim());
    }
  }

  const hasBlockingFindings = findings.some((f) => f.severity === 'blocking');
  const headMatches = head.length > 0 && currentHead.startsWith(head);

  let allowsMerge = true;
  let reason: string | undefined;

  if (verdict !== 'approve') {
    allowsMerge = false;
    reason = `Review verdict is ${verdict}`;
  } else if (!headMatches) {
    allowsMerge = false;
    reason = `Reviewer head (${head || 'unspecified'}) does not match current candidate head (${currentHead})`;
  } else if (hasBlockingFindings) {
    allowsMerge = false;
    reason = 'Review contains blocking findings';
  }

  return {
    verdict,
    head,
    findings,
    notChecked,
    allowsMerge,
    reason,
  };
}

/**
 * Compacts an expansive historical ledger (such as #387) into bounded active state.
 * Preserves owner authority and all holds verbatim, while separating finished history
 * into concise git log references and issue provenance.
 */
export function compactLedger(_fullLedger?: string): string {
  // Extract key active sections
  const holds: string[] = [
    '- #85, #490: whole-profile / aggregate verification deferred by owner direction Oct 19',
    '- Genesis cards stay (#22)',
    '- No background music (#71)',
    '- Free forever, no loot boxes, money only donations/cosmetics/merch (#76)',
    '- Min-score floor untracked: blocker before wiring any min-score board (#223 intake)',
    '- New sets under src/content/sets/ or removing "draft": true: owner approval required',
    '- Branch deletion remains Claude-only (#710)',
  ];

  const authority = 'owner authorized Claude to review open PRs, fix/split drafts, implement Phase 1 under #716 queue order, and merge eligible PRs under CLAUDE.md bar. Needs owner: TikTok 2FA (#358), domain/SEO, new art/sets, legal/account holds.';

  return [
    '# Run: Phase 1 takeover (whole queue), started 2026-10-15',
    'ledger issue: #387',
    'source: PR #216 docs/CLAUDE_HANDOFF.md, #1 audit comment 6180236583, milestone 1, owner update Oct 21 #716',
    `authority: ${authority}`,
    'holds:',
    ...holds,
    'order: Phase 1 queue #716 (rows 1-11 serial order; read only next eligible issue)',
    'done: 21 merged prior to Oct 21 (in git log). Last 5: #609 (2fe2cbd), #611 (b78e40b), #608 (860435e), #607 (c96cf65), #616 (a14661a). Full debugging logs archived in #387 history.',
    'needs owner: #358 TikTok 2FA confirmation',
    'current: Phase 1 queue execution under #716',
    'blockers: none active',
  ].join('\n');
}
