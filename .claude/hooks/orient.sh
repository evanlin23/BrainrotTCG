#!/usr/bin/env bash
# SessionStart hook (startup, resume, clear, compact). Re-orients a fresh or compacted context in a
# few hundred tokens instead of a re-exploration of the repo. Whatever this prints is added to context.
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/orient.mjs" ]; then
  exec node "$SCRIPT_DIR/orient.mjs"
fi

# Fallback when node is unavailable
echo "Branch: $(git branch --show-current 2>/dev/null || echo '?') at $(git log -1 --format='%h %s' 2>/dev/null)"
changes=$(git status --short 2>/dev/null | head -15)
[ -n "$changes" ] && printf 'Uncommitted:\n%s\n' "$changes"

state=.claude/state/NOW.md
if [ -f "$state" ]; then
  echo "--- $state ---"
  head -80 "$state" | cut -c 1-240
  lines=$(grep -c '' "$state")
  [ "$lines" -gt 80 ] && echo "--- $state has $lines lines; only 80 shown (max 240 chars/line). ---"
  echo "--- Status: UNVERIFIED (node unavailable, holds not checked). MERGE/CLOSE/DELETE NOTHING until holds are checked against the ledger issue. ---"
else
  echo "No $state here. Only /work uses it; /work rebuilds it from the \"Claude work ledger\" issue and merges nothing until it does."
  echo "--- Status: MISSING (merge/close/delete forbidden until loaded from ledger issue) ---"
fi
exit 0
