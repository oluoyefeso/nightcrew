#!/usr/bin/env bash
#
# NightCrew — Overnight Claude Code Task Runner
#
# Usage:
#   nightcrew run    [--tasks FILE] [--config FILE] [--dry-run]
#   nightcrew review [--config FILE]
#
set -euo pipefail

NIGHTCREW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NIGHTCREW_VERSION="0.3.2"

# Source all lib modules
for lib in "$NIGHTCREW_DIR"/lib/*.sh; do
  # shellcheck source=/dev/null
  source "$lib"
done

usage() {
  cat <<'EOF'
NightCrew — Overnight Claude Code Task Runner

Usage:
  nightcrew run       [OPTIONS]    Queue tasks and run overnight
  nightcrew review    [OPTIONS]    Morning review dashboard
  nightcrew serve     [OPTIONS]    Start web UI server
  nightcrew preflight [OPTIONS]    Run preflight checks
  nightcrew config    [OPTIONS]    Show resolved configuration
  nightcrew enable    <task-id>    Enable a task
  nightcrew disable   <task-id>    Disable a task
  nightcrew sessions  [OPTIONS]    List archived sessions

Options:
  --tasks FILE     Path to tasks.yaml (default: ./tasks.yaml)
  --config FILE    Path to config.yaml (default: ./config.yaml)
  --dry-run        Show what would run without executing (includes preflight validation)
  --open           Open dashboard in browser after review
  --json           Output as JSON (for preflight, config)
  --port PORT      Server port (default: 3721, for serve)
  --version        Show version
  --help           Show this help

Examples:
  # Before bed
  vim tasks.yaml
  ./nightcrew.sh run

  # In the morning
  ./nightcrew.sh review

  # Web UI
  ./nightcrew.sh serve

  # Check readiness
  ./nightcrew.sh preflight --json
EOF
}

# Parse arguments
COMMAND=""
TASKS_FILE="./tasks.yaml"
CONFIG_FILE="./config.yaml"
DRY_RUN=false
OPEN_DASHBOARD=false
JSON_OUTPUT=false
SERVE_PORT=3721
TASK_ID_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    run|review|serve|preflight|config|sessions)
      COMMAND="$1"
      shift
      ;;
    enable|disable)
      COMMAND="$1"
      shift
      if [[ $# -gt 0 && ! "$1" == --* ]]; then
        TASK_ID_ARG="$1"
        shift
      fi
      ;;
    --tasks)
      TASKS_FILE="$2"
      shift 2
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --open)
      OPEN_DASHBOARD=true
      shift
      ;;
    --json)
      JSON_OUTPUT=true
      shift
      ;;
    --port)
      SERVE_PORT="$2"
      shift 2
      ;;
    --version)
      echo "nightcrew $NIGHTCREW_VERSION"
      exit 0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$COMMAND" ]]; then
  usage
  exit 1
fi

case "$COMMAND" in
  run)
    nightcrew_run "$TASKS_FILE" "$CONFIG_FILE" "$DRY_RUN"
    ;;
  review)
    nightcrew_review "$CONFIG_FILE"
    if [[ "$OPEN_DASHBOARD" == "true" && -f "$NIGHTCREW_DIR/state/dashboard.html" ]]; then
      open "$NIGHTCREW_DIR/state/dashboard.html" 2>/dev/null || \
        xdg-open "$NIGHTCREW_DIR/state/dashboard.html" 2>/dev/null || \
        echo "Dashboard: file://$NIGHTCREW_DIR/state/dashboard.html"
    fi
    ;;
  serve)
    if ! command -v node >/dev/null 2>&1; then
      echo "Error: Node.js is required for 'nightcrew serve'. Install it and try again." >&2
      exit 1
    fi
    if [[ ! -f "$NIGHTCREW_DIR/server.js" ]]; then
      echo "Error: server.js not found in $NIGHTCREW_DIR" >&2
      exit 1
    fi
    export NIGHTCREW_DIR TASKS_FILE CONFIG_FILE SERVE_PORT
    exec node "$NIGHTCREW_DIR/server.js"
    ;;
  preflight)
    nightcrew_preflight "$TASKS_FILE" "$CONFIG_FILE" "$JSON_OUTPUT"
    ;;
  config)
    nightcrew_config "$CONFIG_FILE" "$JSON_OUTPUT"
    ;;
  enable)
    if [[ -z "$TASK_ID_ARG" ]]; then
      echo "Error: task ID required. Usage: nightcrew enable <task-id>" >&2
      exit 1
    fi
    if [[ ! -f "$TASKS_FILE" ]]; then
      echo "Error: tasks file not found: $TASKS_FILE" >&2
      exit 1
    fi
    exists=$(yq e '.tasks[] | select(.id == "'"$TASK_ID_ARG"'") | .id' "$TASKS_FILE")
    if [[ -z "$exists" ]]; then
      echo "Error: task '$TASK_ID_ARG' not found" >&2
      exit 1
    fi
    yq e '(.tasks[] | select(.id == "'"$TASK_ID_ARG"'")).enabled = true' -i "$TASKS_FILE"
    echo "Enabled: $TASK_ID_ARG"
    ;;
  disable)
    if [[ -z "$TASK_ID_ARG" ]]; then
      echo "Error: task ID required. Usage: nightcrew disable <task-id>" >&2
      exit 1
    fi
    if [[ ! -f "$TASKS_FILE" ]]; then
      echo "Error: tasks file not found: $TASKS_FILE" >&2
      exit 1
    fi
    exists=$(yq e '.tasks[] | select(.id == "'"$TASK_ID_ARG"'") | .id' "$TASKS_FILE")
    if [[ -z "$exists" ]]; then
      echo "Error: task '$TASK_ID_ARG' not found" >&2
      exit 1
    fi
    yq e '(.tasks[] | select(.id == "'"$TASK_ID_ARG"'")).enabled = false' -i "$TASKS_FILE"
    echo "Disabled: $TASK_ID_ARG"
    ;;
  sessions)
    sessions_dir="$NIGHTCREW_DIR/state/sessions"
    if [[ ! -d "$sessions_dir" ]]; then
      if [[ "$JSON_OUTPUT" == "true" ]]; then
        echo '{"sessions":[]}'
      else
        echo "No sessions found."
      fi
      exit 0
    fi
    dirs=$(ls -1r "$sessions_dir" 2>/dev/null | head -100)
    if [[ -z "$dirs" ]]; then
      if [[ "$JSON_OUTPUT" == "true" ]]; then
        echo '{"sessions":[]}'
      else
        echo "No sessions found."
      fi
      exit 0
    fi
    if [[ "$JSON_OUTPUT" == "true" ]]; then
      # Build JSON output
      json_sessions="["
      first=true
      while IFS= read -r sid; do
        [[ -z "$sid" ]] && continue
        pf="$sessions_dir/$sid/progress.json"
        if [[ -f "$pf" ]]; then
          task_count=$(jq '.tasks | length' "$pf" 2>/dev/null || echo "0")
          total_cost=$(jq -r '.total_cost_cents // 0' "$pf" 2>/dev/null || echo "0")
          completed=$(jq '[.tasks[] | select(.status == "complete")] | length' "$pf" 2>/dev/null || echo "0")
          failed_count=$(jq '[.tasks[] | select(.status == "failed")] | length' "$pf" 2>/dev/null || echo "0")
        else
          task_count=0; total_cost=0; completed=0; failed_count=0
        fi
        [[ "$first" == "true" ]] && first=false || json_sessions="$json_sessions,"
        json_sessions="$json_sessions{\"id\":\"$sid\",\"task_count\":$task_count,\"total_cost_cents\":$total_cost,\"completed\":$completed,\"failed\":$failed_count}"
      done <<< "$dirs"
      json_sessions="$json_sessions]"
      echo "{\"sessions\":$json_sessions}" | jq '.'
    else
      # Human-readable table
      printf "%-28s %-8s %-10s %-10s %-10s\n" "SESSION" "TASKS" "COST" "PASSED" "FAILED"
      printf "%-28s %-8s %-10s %-10s %-10s\n" "────────────────────────────" "────────" "──────────" "──────────" "──────────"
      while IFS= read -r sid; do
        [[ -z "$sid" ]] && continue
        pf="$sessions_dir/$sid/progress.json"
        if [[ -f "$pf" ]]; then
          task_count=$(jq '.tasks | length' "$pf" 2>/dev/null || echo "0")
          total_cost=$(jq -r '.total_cost_cents // 0' "$pf" 2>/dev/null || echo "0")
          completed=$(jq '[.tasks[] | select(.status == "complete")] | length' "$pf" 2>/dev/null || echo "0")
          failed_count=$(jq '[.tasks[] | select(.status == "failed")] | length' "$pf" 2>/dev/null || echo "0")
        else
          task_count=0; total_cost=0; completed=0; failed_count=0
        fi
        cost_display="\$$(awk "BEGIN {printf \"%.2f\", $total_cost / 100}")"
        printf "%-28s %-8s %-10s %-10s %-10s\n" "$sid" "$task_count" "$cost_display" "$completed" "$failed_count"
      done <<< "$dirs"
    fi
    ;;
esac
