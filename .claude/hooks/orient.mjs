#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function git(command) {
  try {
    return execSync(command, { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const branch = git('git branch --show-current') || '?';
const log = git("git log -1 --format='%h %s'") || '?';
const statusRaw = git('git status --short');
const uncommitted = statusRaw ? statusRaw.split('\n').filter(Boolean).slice(0, 15) : [];

const stateRelativePath = '.claude/state/NOW.md';
const statePath = join(projectDir, stateRelativePath);

console.log(`Branch: ${branch} at ${log}`);
if (uncommitted.length > 0) {
  console.log('Uncommitted:');
  uncommitted.forEach((line) => console.log(line));
}

if (!existsSync(statePath)) {
  console.log(`No ${stateRelativePath} here. Only /work uses it; /work rebuilds it from the "Claude work ledger" issue and merges nothing until it does.`);
  console.log('--- Status: MISSING (merge/close/delete forbidden until loaded from ledger issue) ---');
  process.exit(0);
}

let content = '';
try {
  content = readFileSync(statePath, 'utf8');
} catch {
  console.log(`--- Error reading ${stateRelativePath}; merge/close/delete forbidden until loaded. ---`);
  process.exit(0);
}

const MAX_LINES = 80;
const MAX_CHARS = 3600;
const MAX_LINE_CHARS = 240;

const rawLines = content.split('\n');
const totalLines = rawLines.length;
const totalChars = content.length;

// Top-level keys of the ledger format in .claude/skills/work/SKILL.md, optionally with a note
// such as `holds (fix first, then merge):`. Mirrors projectState in
// scripts/agent-audit/orchestration.ts (a parity test checks they agree).
// Only these keys start a section, so a hold whose text contains a colon stays a hold: every
// non-blank line between `holds:` and the next known key counts as a hold (fail closed).
const LEDGER_KEY = /^(ledger issue|source|authority|holds|order|done|needs owner|current|blockers)(?:\s*\([^)]*\))?\s*:(.*)$/i;
const RUN_HEADER = /^#\s+run\b/i;

let sourceIssue = '';
let currentSection = '';
const holdEntries = [];
const authorityEntries = [];
const holdHeaders = [];
const authorityHeaders = [];

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

const projectedLines = [];
let currentChars = 0;
let truncatedLinesCount = 0;
let authorityTruncated = false;
let holdTruncated = false;
let cutOffLineIndex = totalLines;

for (let i = 0; i < rawLines.length; i++) {
  if (projectedLines.length >= MAX_LINES) {
    cutOffLineIndex = i;
    break;
  }

  let line = rawLines[i];
  const isHoldLine = holdEntries.some((entry) => entry.lineIndex === i);
  const isAuthorityLine = authorityEntries.some((entry) => entry.lineIndex === i);

  if (line.length > MAX_LINE_CHARS) {
    line = line.slice(0, MAX_LINE_CHARS) + '... [line truncated]';
    truncatedLinesCount++;
    if (isHoldLine) holdTruncated = true;
    if (isAuthorityLine) authorityTruncated = true;
  }

  const addedChars = line.length + (projectedLines.length > 0 ? 1 : 0);
  if (currentChars + addedChars > MAX_CHARS) {
    cutOffLineIndex = i;
    break;
  }

  projectedLines.push(line);
  currentChars += addedChars;
}

const holdsPastBoundary = holdEntries.filter((entry) => entry.lineIndex >= cutOffLineIndex);
const authorityPastBoundary = authorityEntries.filter((entry) => entry.lineIndex >= cutOffLineIndex);
const holdHeaderPastBoundary = holdHeaders.some((index) => index >= cutOffLineIndex);
const authorityHeaderPastBoundary = authorityHeaders.some((index) => index >= cutOffLineIndex);

const holdsIncomplete = holdTruncated || holdsPastBoundary.length > 0 || holdHeaderPastBoundary;
const authorityIncomplete = authorityTruncated || authorityPastBoundary.length > 0 || authorityHeaderPastBoundary;

let message = '';
if (authorityEntries.length === 0 && holdEntries.length === 0 && totalLines > 5) {
  message = 'CRITICAL: Authority and holds missing from state. MERGE/CLOSE/DELETE NOTHING until reconciled.';
} else if (holdHeaders.length === 0 || authorityHeaders.length === 0) {
  message = `CRITICAL: ${holdHeaders.length === 0 ? 'holds:' : 'authority:'} section missing from state. MERGE/CLOSE/DELETE NOTHING until reconciled.`;
} else if (holdsIncomplete || authorityIncomplete) {
  const reasons = [];
  if (holdTruncated) reasons.push('hold line truncated');
  if (holdsPastBoundary.length > 0) reasons.push(`${holdsPastBoundary.length} hold(s) past display boundary`);
  if (holdHeaderPastBoundary) reasons.push('holds block past display boundary');
  if (authorityTruncated) reasons.push('authority line truncated');
  if (authorityPastBoundary.length > 0 || authorityHeaderPastBoundary) reasons.push('authority past display boundary');
  message = `CRITICAL OVERFLOW: Authority or holds incomplete (${reasons.join(', ')}). MERGE/CLOSE/DELETE NOTHING until reconciled.`;
} else if (cutOffLineIndex < totalLines || currentChars < totalChars || truncatedLinesCount > 0) {
  message = `WARNING: State truncated to fit budget (${totalLines} lines, ${totalChars} chars -> ${projectedLines.length} lines, ${currentChars} chars shown). Authority and holds intact. Trim history/done before other work.`;
} else {
  message = `OK (compact state: ${projectedLines.length} lines, ${currentChars} chars; ${holdEntries.length} hold(s) tracked; authority loaded).`;
}

const sourceLabel = sourceIssue ? `source: ${sourceIssue}, ` : '';
console.log(`--- ${stateRelativePath} (${sourceLabel}git: ${log.split(' ')[0]}) ---`);
console.log(projectedLines.join('\n'));
console.log(`--- Status: ${message} ---`);
process.exit(0);
