#!/usr/bin/env bash
# SessionStart hook (startup, resume, clear, compact). Re-orients a fresh or compacted context in a
# few hundred tokens instead of a re-exploration of the repo. Whatever this prints is added to context.
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

echo "Branch: $(git branch --show-current 2>/dev/null || echo '?') at $(git log -1 --format='%h %s' 2>/dev/null)"
changes=$(git status --short 2>/dev/null | head -15)
[ -n "$changes" ] && printf 'Uncommitted:\n%s\n' "$changes"

state=.claude/state/NOW.md
if [ -f "$state" ]; then
  echo "--- $state ---"
  head -80 "$state"
  lines=$(wc -l < "$state")
  [ "$lines" -gt 80 ] && echo "--- $state has $lines lines; only 80 shown. Trim done and history to fit before other work. ---"
else
  echo "No $state here. /work rebuilds it from the \"Claude work ledger\" issue; merge nothing until it does."
fi
exit 0
