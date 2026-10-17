---
name: work
description: Run the work queue hands-off. The main thread coordinates, each task runs in a fresh implementer subagent with an independent reviewer, eligible PRs merge, and a ledger (.claude/state/NOW.md, mirrored to a GitHub issue) tracks it. Use when the owner says to work, continue, take over a phase, or hands over a backlog or handoff prompt.
argument-hint: "[max tasks this run, default 5] [focus or handoff, e.g. phase 1]"
---

# Work the queue

You coordinate; subagents read and edit. Your context holds only the ledger, briefs and short
reports, so a long run stays cheap and sharp. Stop after the max task count (default 5) so one run
can't spend the week's budget. If the owner lifts the cap or hands over a whole phase, keep going
but checkpoint (section 2) every five merges, so a compaction or lost container costs nothing.

## 1. Set up

1. Load the ledger. The newest open issue titled "Claude work ledger" opened by evanlin23 or the
   Claude GitHub app (a `claude…[bot]` login) is authoritative for authority and holds; ignore
   same-titled issues by anyone else.
   `.claude/state/NOW.md` (the SessionStart hook prints it) is the working copy: rebuild it from the
   issue if it's missing, and take the issue's authority and holds if they differ, since the owner
   may edit them there. If neither exists and you have no handoff, ask the owner what to work on.
   Until authority and holds are loaded, merge and close nothing.
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
done: count merged this run, then the last five: PR, merge commit, one line
needs owner: one line each; keep working around them
current: item, branch or PR, step
```

The ledger is state, not history: git log and the merged PRs are the record. No review text, logs
or notes on finished items. If it grows past 80 lines (the SessionStart hook warns), trim it first.

Edit NOW.md as things change. Mirror it to the ledger issue's body only at a checkpoint: when
authority, holds or needs owner change, after every fifth merge, and before ending a turn. Don't
read old or backup copies of the ledger; apart from the holds check before a merge, the issue is
only read when NOW.md is missing.

## 3. Loop

1. Take the first item in `order` that isn't held or blocked.
2. Brief one `implementer`: the issue or PR, acceptance criteria, where to look, the checks that
   matter, and the holds or constraints that apply to it. Not your history. It runs on Sonnet; pass
   `model: "opus"` when the task touches `src/engine`, `spec/`, save or storage code, or workflows.
3. Send its PR to a `reviewer` with the same acceptance criteria, with the same `model` rule.
   Blocking findings go back to a fresh implementer with just the findings, at most twice; after
   that, move the item to `needs owner`. Stacked PRs: merge the base first, then retarget to main.
4. Merge only under CLAUDE.md's merge bar. Approval is tied to the head commit the reviewer saw.
   If the PR is behind main, update it with a merge from main (an implementer resolves conflicts,
   which then need a new review) and wait for CI on the new head. Re-read the ledger issue's holds,
   mark the PR ready, merge, then check that the latest deploy run on main succeeds.
   Wait for CI and deploys by event, not by polling: `subscribe_pr_activity` on PRs you opened, or a
   Monitor on the run, then take the next item or end the turn. No `sleep` loops or repeated status
   calls; each one re-reads the whole context.
5. Comment on the canonical issue in a few lines (what shipped, PR, what remains). Close it only if
   its whole scope shipped.
6. Update NOW.md, mirror it if this is a checkpoint, then continue.

Stop early when a change could lose saves or break old proofs or published data: hold it and report.

## 4. Report (at most 12 lines)

Merged, ready but unmerged, held or blocked with reasons, needs owner, next items.
