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
4. Close duplicate, superseded or obsolete PRs (the owner allows it), each with a one-line comment
   naming the reason or the superseding PR. Leave held PRs open.
5. Put the rest into the ledger's `order`, merge-ready first, holds excluded. /work then takes them
   one at a time (update from main, review, merge) so each review is against the real base.
6. Post the table once on the tracking issue, then keep only the order in `.claude/state/NOW.md`.
