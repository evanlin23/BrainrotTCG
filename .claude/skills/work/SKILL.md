---
name: work
description: Run the work queue hands-off. The main thread coordinates, each task runs in a fresh implementer subagent with an independent reviewer, eligible PRs merge, and a ledger (.claude/state/NOW.md, mirrored to a GitHub issue) tracks it. Use when the owner says to work, continue, take over a phase, or hands over a backlog or handoff prompt.
argument-hint: "[max tasks this run, default 5] [focus or handoff, e.g. phase 1]"
---

# Work the queue

You coordinate; subagents read and edit. Your context holds only the ledger, briefs and short
reports, so a long run stays cheap and sharp. Stop after the max task count (default 5) so one run
can't spend the week's budget.

## 1. Set up

1. Load the ledger. Use `.claude/state/NOW.md` (the SessionStart hook prints it) if it exists.
   Otherwise rebuild it from the body of the open issue titled "Claude work ledger". If neither
   exists and you have no handoff, ask the owner what to work on. Until authority and holds are
   loaded, merge and close nothing.
2. New handoff, milestone or audit? Have one `researcher` or general-purpose agent read it and the
   linked issues and return the ledger fields below. Don't read long handoff docs here. Create the
   ledger issue if it doesn't exist.
3. Refresh: `git fetch origin main`, list open PRs (fields: number, title, draft, head, base) and the
   check runs of PRs you opened. Red CI on your own PRs comes before new work.
4. More than about five open PRs and no triage recorded? Run /triage-prs first.

## 2. Keep the ledger (under 80 lines)

```
# Run: <focus>, started <date>
ledger issue: #<n>
authority: what the owner allowed (phases, merge, close) and what still needs them
holds: PR or issue numbers that must not merge, with the reason
order: numbered queue, one line each: issue or PR, outcome, risk tier
done: PR, merge commit, one line
needs owner: one line each; keep working around them
current: item, branch or PR, step
```

Whenever authority, holds or order change, and after every merge, write the same text to the
ledger issue's body.

## 3. Loop

1. Take the first item in `order` that isn't held or blocked.
2. Brief one `implementer`: the issue or PR, acceptance criteria, where to look, the checks that
   matter, and the holds or constraints that apply to it. Not your history.
3. Send its PR to a `reviewer` with the same acceptance criteria. Pass `model: "opus"` when it
   touches `src/engine`, `spec/`, save or storage code, or workflows. Blocking findings go back to an
   implementer, at most twice; after that, move the item to `needs owner`. Stacked PRs: merge the
   base first, then retarget to main.
4. Merge only under CLAUDE.md's merge bar, with approval tied to the head commit the reviewer saw.
   Before merging an engine, spec or storage change, run its rule-specific checks on that head.
   After merging, check that main's deploy run succeeds.
5. Comment on the canonical issue in a few lines (what shipped, PR, what remains). Close it only if
   its whole scope shipped.
6. Update the ledger and its issue, then continue.

Stop early when a change could lose saves or break old proofs or published data: hold it and report.

## 4. Report (at most 12 lines)

Merged, ready but unmerged, held or blocked with reasons, needs owner, next items.
