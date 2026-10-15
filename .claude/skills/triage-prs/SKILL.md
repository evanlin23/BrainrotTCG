---
name: triage-prs
description: Shrink the open PR queue cheaply. Sizes up every open PR with the pr-triage subagent, then proposes what to close, merge or fix, in dependency order. Use when more than about five PRs are open, or before reviewing a backlog.
---

# Triage the PR queue

Deep-reviewing a large queue is the most expensive thing in this repo. In October 2026, 55 open agent
branches held about 570k tokens of diff and 50 of them touched `src/App.tsx`, so each merge
invalidated reviews of the rest. Triage first; deep-review only what merges next.

1. List open PRs (fields: number, title, draft, head, base, updated_at, changed_files; perPage 50).
2. Group them by area (same issue or same files). Send each group to one `pr-triage` agent with the
   PR numbers and branch names, at most three agents at a time.
3. Combine the verdicts into one table: close, then merge-ready, small-fix, rework. Keep stacked PRs
   (base isn't main) in stack order.
4. Show the table and ask the owner to approve the closures and the merge order. Don't close, merge
   or comment before that.
5. After approval, close the approved PRs with one short comment each naming the reason or the
   superseding PR. Then take merge-ready PRs one at a time: update from main, `npm run check`, and
   merge only if the owner said to, before reviewing the next, so each review is against the real base.
6. Record the outcome and the remaining order in `.claude/state/NOW.md`.
