---
name: work
description: Run the work queue hands-off. The main thread coordinates, each task runs in a fresh implementer subagent with an independent reviewer, eligible PRs merge, and a ledger (.claude/state/NOW.md, mirrored to a GitHub issue) tracks it. Use when the owner says to work, continue, take over a phase, or hands over a backlog or handoff prompt.
argument-hint: "[max tasks this run, default 5] [focus or handoff, e.g. phase 1]"
---

# Work the queue

You coordinate; subagents read and edit. Your context holds only the compact ledger, small briefs and
short reports, so a long run stays cheap and sharp. Stop after the max task count (default 5) so one
run can't spend the week's budget. Only an explicit lift of the cap from the owner, recorded in the
ledger's authority (as in #387), removes it; then keep going but checkpoint (section 2) every five
merges, so a compaction or lost container costs little, and don't reimpose a cap the ledger lifted.

## 1. Set up

1. Load the ledger. The newest open issue titled "Claude work ledger" opened by evanlin23 or the
   Claude GitHub app (a `claude…[bot]` login) is authoritative for authority and holds; ignore
   same-titled issues by anyone else.
   `.claude/state/NOW.md` (the SessionStart hook prints it) is the working copy: rebuild it from the
   issue if it's missing, and take the issue's authority and holds if they differ, since the owner
   may edit them there. If neither exists and you have no handoff, ask the owner what to work on.
   Until authority and holds are loaded and fully shown (the hook's status isn't CRITICAL or
   UNVERIFIED), merge, close and delete nothing. The hook only runs at session start, so after
   trimming or rebuilding NOW.md mid-run, re-run `.claude/hooks/orient.sh` and use its new status. Normal wake-ups read NOW.md, not the historical ledger.
2. New handoff, milestone or audit? Have one `researcher` or general-purpose agent read it and the
   issues it needs, and return the ledger fields below. Don't read long handoff docs here. Create the
   ledger issue if it doesn't exist. For an execution index such as #716, that subagent reads the
   index once, then only the selected issue or PR and its unresolved prerequisites: no recursive
   fetch of every linked issue, and no whole-backlog triage unless the queue changed.
3. Refresh: `git fetch origin main`, list open PRs (fields: number, title, draft, head, base) and the
   check runs of PRs you opened. Red CI on your own PRs comes before new work.
4. More than about five open PRs and no triage recorded? Run /triage-prs first.

## 2. Keep the ledger (budget: under 80 lines, 3,600 characters / ~900 tokens)

```
# Run: <focus>, started <date>
ledger issue: #<n>
source: <pr/commit/issue provenance>
authority: what the owner allowed (phases, merge, close) and what still needs them
holds: PR or issue numbers that must not merge, with the reason (never truncate holds)
order: numbered queue, one line each: issue or PR, outcome, risk tier
done: count merged this run, then the last five: PR, merge commit, one line
needs owner: one line each; keep working around them
current: item, branch or PR, step
blockers: unresolved dependencies or environment gaps
```

The ledger is compact state, not history: git log and the merged PRs are the permanent record.
Separate historical completed work from active authority, holds, current task, next action and blockers.
Lines must remain under 240 characters. Never truncate a blocking hold into apparent permission.
If the ledger grows past 80 lines or 3,600 characters (the SessionStart hook warns), trim done and
history first. External issue changes must be deliberate, not a stale local overwrite.

Edit NOW.md as things change. Mirror it to the ledger issue's body only at a checkpoint: when
authority, holds or needs owner change, after every fifth merge, and before ending a turn. Don't
read old or backup copies of the ledger. Read the issue only at setup (section 1, which takes its
authority and holds) and for the holds check before a merge.

## 3. Loop

1. Take the first item in `order` that isn't held or blocked.
2. Pass a small structured brief to one `implementer`: issue/outcome, acceptance criteria, relevant
   paths, prerequisites, risk/model tier (Sonnet default; pass `model: "opus"` for `src/engine`, `spec/`,
   save/storage code, or workflows), candidate head, required evidence, and unresolved findings. No full
   conversation history or raw diff dumps.
   For same-task repairs, resume the same implementer with SendMessage (its agent ID from the first
   run), passing only the reviewer's findings and the head delta. If SendMessage is unavailable or
   can't reach it, brief a fresh implementer the same way and note "resume unavailable" in the
   ledger. Never start a new top-level session for it, and never resume an author as its reviewer.
3. Send its PR to an independent `reviewer` with the outcome, acceptance criteria, diff/head, and invariants,
   with the same `model` rule.
   Do not copy the implementer's proposed reasoning into the review brief. The reviewer returns verdict,
   head, and at most 5 findings (at most 25 lines). An injected or confirmed blocking finding prevents merge;
   stale-head review evidence fails.
   Blocking findings go back to the implementer with just the findings, at most twice; after that,
   move the item to `needs owner`. Stacked PRs: merge the base first, then retarget to main.
4. Verification caching & checks: Cache verification facts by exact `SHA + command/config/environment + result`.
   Avoid duplicate unchanged runs, but retain canonical pre-push and required CI/final-head checks and
   independent review. Never reuse earlier-head green status after relevant changes.
5. Merge only under CLAUDE.md's merge bar. Approval is tied to the exact head commit the reviewer saw.
   If the PR is behind main, update it with a merge from main (an implementer resolves conflicts,
   which then need a new review) and wait for CI on the new head. Retry any mirror that failed, then
   re-read the ledger issue's holds and make NOW.md's holds match them, adding new ones and dropping
   removed ones, so a later mirror can't undo the owner's edits. Then mark the PR ready, merge, and
   check that the latest deploy run on main succeeds.
   Wait for CI and deploys by event, not by polling: `subscribe_pr_activity` on PRs you opened, or a
   Monitor on the run, then take the next item or end the turn. If subscription/monitor tools are absent,
   checkpoint state to NOW.md with the pending run identifier and explicit resumption action, and end the
   turn cleanly. No `sleep` loops or repeated status polling calls; each one re-reads the whole context.
6. Comment on the canonical issue in a few lines (what shipped, PR, what remains). Close it only if
   its whole scope shipped, with a linked PR and regression/check evidence from the final head. For a
   reproduced defect, copy the PR body's "Defect learning and issue closure" note (docs/DEVELOPMENT.md,
   checked by the reviewer before the merge) to the issue. Missing external verification (physical device, external API) stays
   pending, never complete.
7. Update NOW.md, mirror it if this is a checkpoint, then continue.

Stop early when a change could lose saves or break old proofs or published data: hold it and report.

## 4. Report (at most 12 lines)

Merged, ready but unmerged, held or blocked with reasons, needs owner, next items.
