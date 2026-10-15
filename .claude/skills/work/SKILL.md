---
name: work
description: Run the work queue hands-off. The main thread coordinates, each task runs in a fresh implementer subagent with an independent reviewer, eligible PRs merge, and .claude/state/NOW.md keeps the ledger. Use when the owner says to work, continue, take over a phase, or hands over a backlog or handoff prompt.
argument-hint: "[max tasks this run, default 5] [focus or handoff, e.g. phase 1]"
---

# Work the queue

You coordinate; subagents read and edit. Your context holds only the ledger, briefs and short
reports, so a long run stays cheap and sharp. Stop after the max task count (default 5) so one run
can't spend the week's budget.

## 1. Set up

1. Read `.claude/state/NOW.md` (the SessionStart hook prints it). Resume `current` if one is open.
2. New handoff, milestone or audit? Have one `researcher` or general-purpose agent read it and the
   linked issues and return the ledger fields below. Don't read long handoff docs here.
3. Refresh: `git fetch origin main`, list open PRs (fields only) and the check runs of those you
   opened. Red CI on your PRs comes before new work.
4. More than about five open PRs and no recorded triage? Run /triage-prs first.

## 2. Keep the ledger (`.claude/state/NOW.md`, under 80 lines)

```
# Run: <focus>, started <date>
authority: what the owner allowed (merge? which phases? which actions need them?)
holds: PR or issue numbers that must not merge, with the reason
order: numbered queue, one line each: issue or PR, outcome, risk tier
done: PR, merge commit, one line
needs owner: one line each; keep working around them
current: item, branch or PR, step
```

Mirror it to GitHub when it changes materially (a comment on the tracking issue) so a lost
container loses nothing.

## 3. Loop

1. Take the first item in `order` that isn't held or blocked.
2. Brief one `implementer`: the issue or PR, acceptance criteria, where to look, the checks that
   matter, and the holds or constraints that apply to it. Not your history.
3. Send its PR to a `reviewer` with the same acceptance criteria. Pass `model: "opus"` when the PR
   touches `src/engine`, `spec/`, save or storage code, or workflows. Blocking findings go back to an
   implementer, at most twice; after that, move the item to `needs owner`.
4. Merge only as CLAUDE.md allows. Before merging an engine, spec or storage change, run its
   rule-specific checks on the final head. After merging, confirm main's CI and deploy started.
5. Comment on the canonical issue in a few lines (what shipped, PR, what remains). Close it only if
   its whole scope shipped.
6. Update the ledger and continue.

Stop early when a change could lose saves or break old proofs or published data: hold it and report.

## 4. Report (at most 12 lines)

Merged, ready but unmerged, held or blocked with reasons, needs owner, next items.
