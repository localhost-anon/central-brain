#!/usr/bin/env bash
# Injects a "consult Central Brain first" reminder into every user prompt (UserPromptSubmit).
# Read-only and fail-open: any error still lets the prompt through, just without the reminder.
set -u
DB="${BRAIN_DB:-$HOME/.central-brain/brain.db}"
prompt=$(jq -r '.prompt // ""' 2>/dev/null)

# Slash commands and empty prompts get no reminder.
case "$prompt" in /*|"") exit 0 ;; esac

# Same staleness rule as `brain goal current` (activity.ts staleDays): positive number, else 7.
stale_days="${BRAIN_STALE_DAYS:-7}"
if ! printf '%s' "$stale_days" | grep -Eq '^[0-9]+([.][0-9]+)?$' || \
   ! awk -v d="$stale_days" 'BEGIN { exit !(d > 0) }'; then
  stale_days=7
fi

goal=""
if [ -f "$DB" ]; then
  # query_only, not -readonly: -readonly cannot open a WAL database when no other
  # connection holds its -shm file, which silently dropped the goal line.
  goal=$(sqlite3 -cmd "PRAGMA query_only=ON" "$DB" \
    "SELECT id || ' (' || status || '): ' || title FROM goals
     WHERE status IN ('LOCKED','PLANNING','EXECUTING','VERIFYING','BLOCKED')
       AND julianday('now') - julianday(updated_at) <= $stale_days
     ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null)
fi

if [ -n "$goal" ]; then
  goal_line="Active Brain goal: $goal. If this prompt belongs to it, continue it (brain_goal_resume); otherwise treat it as new work."
else
  goal_line="No active Brain goal."
fi

msg="Central Brain first: before acting, run brain_context_search on this prompt (brain_failure_search for errors) to recall prior decisions, fixes, preferences and the target project's path. If this prompt will change anything (files, config, git commit/merge/push, deploys, infra), create a goal and run brain_goal_intake before the first change, then stay inside its locked scope (deploys/pushes need explicit user OK). Read-only prompts: search only. Fall back to the default approach only if Brain has nothing relevant or is unavailable, and say so. $goal_line"

jq -n --arg ctx "$msg" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}'
