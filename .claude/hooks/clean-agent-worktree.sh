#!/usr/bin/env bash
# SubagentStop hook. Each finished subagent worktree (.claude/worktrees/agent-<agent_id>) kept about
# 400MB of node_modules and build output, and thirty of them filled the container's disk. This
# removes only those regenerable folders from the stopping agent's own worktree; a resumed agent
# reinstalls with `npm ci` (CLAUDE.md). test-results stays: other agents read evidence from it after
# its producer stops. Source, .git and every other path are left alone, and nothing is removed while
# any process still runs inside that worktree. Never blocks the agent: always exits 0.
cd / 2>/dev/null || exit 0
[ -n "${CLAUDE_PROJECT_DIR:-}" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# agent_id from the hook's JSON input (code.claude.com/docs/en/hooks, SubagentStop input).
id=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).agent_id;if(typeof v==="string")process.stdout.write(v)}catch{}})' 2>/dev/null)
[[ "$id" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || exit 0

# Every path is resolved and must be exactly where it should be inside the real project: no symlinked
# .claude or .claude/worktrees, and no agent-<id> symlink out of it. The worktree's .git must be a
# file (a git worktree), never the main checkout's .git directory.
project=$(realpath -e -- "$CLAUDE_PROJECT_DIR" 2>/dev/null) || exit 0
root=$(realpath -e -- "$project/.claude/worktrees" 2>/dev/null) || exit 0
[ "$root" = "$project/.claude/worktrees" ] || exit 0
wt=$(realpath -e -- "$root/agent-$id" 2>/dev/null) || exit 0
[ "$wt" = "$root/agent-$id" ] && [ -d "$wt" ] && [ -f "$wt/.git" ] || exit 0

# Skip while any process other than this hook and its ancestors (the shell that ran it may sit in
# the worktree) has its cwd inside the worktree, so a background build or test keeps node_modules.
skip=" $$ "
pid=$$
while [ "$pid" -gt 1 ] 2>/dev/null; do
  ppid=
  while read -r key value; do
    [ "$key" = "PPid:" ] && { ppid=$value; break; }
  done < "/proc/$pid/status" 2>/dev/null
  [ -n "$ppid" ] || break
  pid=$ppid
  skip+="$pid "
done
# One find call lists every process's cwd (a readlink per process is seconds on a busy machine). Fail
# closed: unless the scan listed this hook's own process, it saw nothing and proves nothing.
saw_self=
while IFS=$'\t' read -r -d '' dir cwd; do
  p=${dir#/proc/}
  [[ "$p" =~ ^[0-9]+$ ]] || continue
  [ "$p" = "$$" ] && saw_self=1
  [[ "$skip" == *" $p "* ]] && continue
  if [ "$cwd" = "$wt" ] || [[ "$cwd" == "$wt/"* ]]; then
    echo "Kept agent-$id build output: process $p is still running in it."
    exit 0
  fi
done < <(find /proc -mindepth 2 -maxdepth 2 -name cwd -printf '%h\t%l\0' 2>/dev/null)
[ -n "$saw_self" ] || exit 0

# Rename each folder aside first, so a timeout mid-delete can't leave a partial node_modules that
# looks installed; leftovers from an earlier interrupted run are deleted too. Real directories only:
# a symlink could point anywhere.
removed=()
for name in node_modules dist playwright-report blob-report; do
  target="$wt/$name"
  if [ -d "$target" ] && [ ! -L "$target" ] && mv -T -- "$target" "$wt/.cleaning-$$-$name" 2>/dev/null; then
    removed+=("$name")
  fi
done
for left in "$wt"/.cleaning-*; do
  [ -d "$left" ] && [ ! -L "$left" ] && rm -rf -- "$left" 2>/dev/null
done
[ "${#removed[@]}" -gt 0 ] && echo "Cleaned agent-$id worktree: removed ${removed[*]}."
exit 0
