#!/usr/bin/env bash
# SessionStart hook (startup, resume). A fresh container or worktree has no node_modules, so tests,
# lint and tsc fail until `npm ci` runs. Installs only when node_modules is missing; never fails the session.
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
[ -f package-lock.json ] || exit 0
[ -d node_modules ] && exit 0

if npm ci --no-audit --no-fund >/dev/null 2>&1; then
  echo "Installed dependencies with npm ci (node_modules was missing)."
else
  echo "Warning: npm ci failed; run it by hand before tests or checks."
fi
exit 0
