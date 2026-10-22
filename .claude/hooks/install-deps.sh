#!/usr/bin/env bash
# SessionStart hook (startup, resume). A fresh container or worktree has no node_modules, so tests,
# lint and tsc fail until `npm ci` runs. Installs when node_modules/.package-lock.json is missing (npm
# writes it last, so a folder left by a failed or killed install doesn't count); never fails the session.
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
[ -f package-lock.json ] || exit 0
[ -f node_modules/.package-lock.json ] && exit 0

if out=$(npm ci --no-audit --no-fund 2>&1); then
  echo "Installed dependencies with npm ci (node_modules was missing or incomplete)."
else
  echo "Warning: npm ci failed; run it by hand before tests or checks. Last output:"
  printf '%s\n' "$out" | tail -n 5
fi
exit 0
