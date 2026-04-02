#!/usr/bin/env bash
# State management for progress.json

STATE_DIR=""
STATE_FILE=""

init_state() {
  local base_dir="${1:-.}"
  STATE_DIR="$base_dir/state"
  STATE_FILE="$STATE_DIR/progress.json"
  mkdir -p "$STATE_DIR"

  if [[ ! -f "$STATE_FILE" ]]; then
    echo '{"session_started":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","tasks":{},"total_cost_cents":0,"total_input_tokens":0,"total_output_tokens":0}' | jq '.' > "$STATE_FILE"
  fi
}

get_task_status() {
  local task_id="$1"
  jq -r ".tasks[\"$task_id\"].status // \"pending\"" "$STATE_FILE"
}

mark_task() {
  local status="$1"
  local task_id="$2"
  local extra="${3:-}"

  local tmp
  tmp=$(mktemp)
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  case "$status" in
    in_progress)
      jq --arg id "$task_id" --arg ts "$now" \
        '.tasks[$id].status = "in_progress" | .tasks[$id].started_at = $ts' \
        "$STATE_FILE" > "$tmp"
      ;;
    complete)
      jq --arg id "$task_id" --arg ts "$now" --arg pr "${extra:-}" \
        '.tasks[$id].status = "complete" | .tasks[$id].completed_at = $ts | .tasks[$id].pr_url = $pr' \
        "$STATE_FILE" > "$tmp"
      ;;
    failed)
      jq --arg id "$task_id" --arg ts "$now" --arg reason "${extra:-unknown}" \
        '.tasks[$id].status = "failed" | .tasks[$id].failed_at = $ts | .tasks[$id].reason = $reason' \
        "$STATE_FILE" > "$tmp"
      ;;
    timeout)
      jq --arg id "$task_id" --arg ts "$now" \
        '.tasks[$id].status = "timeout" | .tasks[$id].timed_out_at = $ts' \
        "$STATE_FILE" > "$tmp"
      ;;
    paused)
      jq --arg id "$task_id" --arg ts "$now" \
        '.tasks[$id].status = "paused" | .tasks[$id].paused_at = $ts' \
        "$STATE_FILE" > "$tmp"
      ;;
    blocked)
      jq --arg id "$task_id" --arg ts "$now" --arg blocker "${extra:-unknown}" \
        '.tasks[$id].status = "blocked" | .tasks[$id].blocked_at = $ts | .tasks[$id].blocked_by = $blocker' \
        "$STATE_FILE" > "$tmp"
      ;;
  esac

  mv "$tmp" "$STATE_FILE"
}

set_task_field() {
  local task_id="$1"
  local field="$2"
  local value="$3"

  local tmp
  tmp=$(mktemp)
  jq --arg id "$task_id" --arg field "$field" --arg val "$value" \
    '.tasks[$id][$field] = $val' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

add_cost() {
  local cents="$1"
  local tmp
  tmp=$(mktemp)
  jq --argjson c "$cents" '.total_cost_cents += $c' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

add_tokens() {
  local input_tokens="$1"
  local output_tokens="$2"
  local tmp
  tmp=$(mktemp)
  jq --argjson i "$input_tokens" --argjson o "$output_tokens" \
    '.total_input_tokens += $i | .total_output_tokens += $o' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

get_total_cost() {
  jq -r '.total_cost_cents' "$STATE_FILE"
}

# Session directory for the current run (set by init_session, used for log paths)
SESSION_DIR=""
SESSION_ID=""

# Create a session directory for this run and set SESSION_DIR/SESSION_ID
init_session() {
  local base_dir="${1:-.}"
  SESSION_ID=$(date -u +%Y-%m-%dT%H%M%SZ)
  SESSION_DIR="$base_dir/state/sessions/$SESSION_ID"
  mkdir -p "$SESSION_DIR/logs"
}

# Get the log path for a task phase within the current session
session_log_path() {
  local task_id="$1"
  local phase="$2"  # plan, impl, review
  echo "$SESSION_DIR/logs/${task_id}-${phase}.log"
}

# Archive the current session: copy progress.json snapshot into the session folder
archive_session() {
  local base_dir="${1:-.}"
  if [[ -z "$SESSION_DIR" || ! -d "$SESSION_DIR" ]]; then
    return 0  # no session to archive
  fi

  # Snapshot progress.json into the session folder
  if [[ -f "$STATE_FILE" ]]; then
    cp "$STATE_FILE" "$SESSION_DIR/progress.json"
  fi

  # Update log_file paths in the archived progress.json to be relative to session dir
  # (the live STATE_FILE keeps absolute paths for backwards compat)
  if [[ -f "$SESSION_DIR/progress.json" ]]; then
    local tmp
    tmp=$(mktemp)
    jq --arg sid "$SESSION_ID" \
      '.session_id = $sid' "$SESSION_DIR/progress.json" > "$tmp"
    mv "$tmp" "$SESSION_DIR/progress.json"
  fi
}

# List all archived sessions (newest first)
list_sessions() {
  local base_dir="${1:-.}"
  local sessions_dir="$base_dir/state/sessions"
  if [[ -d "$sessions_dir" ]]; then
    ls -1r "$sessions_dir" 2>/dev/null | head -100
  fi
}

write_sentinel() {
  local base_dir="${1:-.}"
  local summary="$2"
  cat > "$base_dir/state/done" <<EOF
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
$summary
EOF
}
