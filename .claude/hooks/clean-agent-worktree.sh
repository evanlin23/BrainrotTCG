#!/usr/bin/env bash
# SubagentStop hook. Each finished subagent worktree (.claude/worktrees/agent-<agent_id>) kept about
# 400MB of node_modules, build and test output, and thirty of them filled the container's disk. This
# removes only those regenerable folders from the stopping agent's own worktree; a resumed agent
# reinstalls with `npm ci` (CLAUDE.md). Source, .git and every other path are left alone, and it is
# skipped while any process still runs inside that worktree. Never blocks the agent: always exits 0.
cd / 2>/dev/null || exit 0
[ -n "${CLAUDE_PROJECT_DIR:-}" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# agent_id from the hook's JSON input (code.claude.com/docs/en/hooks, SubagentStop input).
id=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).agent_id;if(typeof v==="string")process.stdout.write(v)}catch{}})' 2>/dev/null)
[[ "$id" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || exit 0

root=$(realpath -e -- "$CLAUDE_PROJECT_DIR/.claude/worktrees" 2>/dev/null) || exit 0
wt=$(realpath -e -- "$root/agent-$id" 2>/dev/null) || exit 0
# The resolved path must be exactly that child of the worktrees folder (no symlink out of it), a
# directory, and a git worktree (its .git is a file, not the main checkout's .git directory).
[ "$wt" = "$root/agent-$id" ] && [ -d "$wt" ] && [ -f "$wt/.git" ] || exit 0

# Skip while any process other than this hook and its ancestors has its cwd inside the worktree, so
# a background build or test keeps its node_modules.
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
# One find call lists every process's cwd (a readlink per process is seconds on a busy machine).
while IFS=$'\t' read -r -d '' dir cwd; do
  p=${dir#/proc/}
  [[ "$p" =~ ^[0-9]+$ ]] || continue
  [[ "$skip" == *" $p "* ]] && continue
  if [ "$cwd" = "$wt" ] || [[ "$cwd" == "$wt/"* ]]; then
    echo "Kept agent-$id build output: process $p is still running in it."
    exit 0
  fi
done < <(find /proc -mindepth 2 -maxdepth 2 -name cwd -printf '%h\t%l\0' 2>/dev/null)

removed=()
for name in node_modules dist test-results playwright-report blob-report; do
  target="$wt/$name"
  # Real directories only: a symlink could point anywhere.
  if [ -d "$target" ] && [ ! -L "$target" ]; then
    rm -rf -- "$target" 2>/dev/null
    [ -e "$target" ] || removed+=("$name")
  fi
done
[ "${#removed[@]}" -gt 0 ] && echo "Cleaned agent-$id worktree: removed ${removed[*]}."
exit 0
