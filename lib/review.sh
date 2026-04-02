#!/usr/bin/env bash
# Morning review dashboard

nightcrew_review() {
  local config_file="$1"

  local state_file="$NIGHTCREW_DIR/state/progress.json"

  if [[ ! -f "$state_file" ]]; then
    log "No state file found. Run 'nightcrew run' first."
    return 1
  fi

  local session_started
  session_started=$(jq -r '.session_started' "$state_file")
  local total_cost
  total_cost=$(jq -r '.total_cost_cents' "$state_file")
  local task_ids
  task_ids=$(jq -r '.tasks | keys[]' "$state_file" 2>/dev/null || true)

  if [[ -z "$task_ids" ]]; then
    log "No tasks recorded in state."
    return 0
  fi

  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║                    NIGHTCREW MORNING REVIEW                     ║"
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║  Session started: $session_started"
  echo "║  Total cost:      ~\$$(awk "BEGIN {printf \"%.2f\", $total_cost / 100}")"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  echo ""

  # Table header
  printf "%-20s %-12s %-8s %-10s %s\n" "TASK" "STATUS" "COST" "MODEL" "PR"
  printf "%-20s %-12s %-8s %-10s %s\n" "────────────────────" "────────────" "────────" "──────────" "──────────────────────────"

  while IFS= read -r task_id; do
    [[ -z "$task_id" ]] && continue

    local status cost model pr_url
    status=$(jq -r ".tasks[\"$task_id\"].status // \"unknown\"" "$state_file")
    cost=$(jq -r ".tasks[\"$task_id\"].cost_cents // \"0\"" "$state_file")
    model=$(jq -r ".tasks[\"$task_id\"].model // \"-\"" "$state_file")
    pr_url=$(jq -r ".tasks[\"$task_id\"].pr_url // \"-\"" "$state_file")

    # Shorten model name for display
    local model_short
    case "$model" in
      *opus*)   model_short="opus" ;;
      *sonnet*) model_short="sonnet" ;;
      *)        model_short="$model" ;;
    esac

    # Status with indicator
    local status_display
    case "$status" in
      complete) status_display="✅ complete" ;;
      failed)   status_display="❌ failed" ;;
      timeout)  status_display="⏰ timeout" ;;
      paused)   status_display="⏸  paused" ;;
      blocked)
        local blocked_by
        blocked_by=$(jq -r ".tasks[\"$task_id\"].blocked_by // \"-\"" "$state_file")
        status_display="🚫 blocked:$blocked_by"
        ;;
      *)        status_display="$status" ;;
    esac

    local cost_display
    cost_display="\$$(awk "BEGIN {printf \"%.2f\", $cost / 100}")"

    # Truncate task_id for display
    local id_display="${task_id:0:20}"

    printf "%-20s %-12s %-8s %-10s %s\n" "$id_display" "$status_display" "$cost_display" "$model_short" "$pr_url"
  done <<< "$task_ids"

  echo ""

  # Detailed sections
  while IFS= read -r task_id; do
    [[ -z "$task_id" ]] && continue

    local status
    status=$(jq -r ".tasks[\"$task_id\"].status" "$state_file")

    # Show diff summary for completed tasks
    if [[ "$status" == "complete" ]]; then
      local pr_url
      pr_url=$(jq -r ".tasks[\"$task_id\"].pr_url // \"\"" "$state_file")
      if [[ -n "$pr_url" && "$pr_url" != "-" && "$pr_url" != "null" ]]; then
        echo "── $task_id (complete) ──────────────────────"
        local pr_number
        pr_number=$(echo "$pr_url" | grep -oE '[0-9]+$' || true)
        if [[ -n "$pr_number" ]]; then
          echo "PR: $pr_url"
          gh pr diff "$pr_number" --stat 2>/dev/null || echo "  (could not fetch diff)"
        fi
        echo ""
      fi
    fi

    # Show failure reason
    if [[ "$status" == "failed" ]]; then
      local reason
      reason=$(jq -r ".tasks[\"$task_id\"].reason // \"unknown\"" "$state_file")
      echo "── $task_id (failed) ───────────────────────"
      echo "  Reason: $reason"
      local log_file
      log_file=$(jq -r ".tasks[\"$task_id\"].log_file // \"\"" "$state_file")
      if [[ -n "$log_file" && -f "$log_file" ]]; then
        echo "  Log: $log_file"
        echo "  Last 5 lines:"
        tail -5 "$log_file" 2>/dev/null | sed 's/^/    /'
      fi
      echo ""
    fi

    # Show paused tasks
    if [[ "$status" == "paused" ]]; then
      echo "── $task_id (paused) ───────────────────────"
      echo "  Re-run 'nightcrew run' to resume this task."
      echo ""
    fi

    # Show blocked tasks
    if [[ "$status" == "blocked" ]]; then
      local blocked_by
      blocked_by=$(jq -r ".tasks[\"$task_id\"].blocked_by // \"unknown\"" "$state_file")
      echo "── $task_id (blocked) ──────────────────────"
      echo "  Blocked by: $blocked_by"
      echo "  Fix or complete '$blocked_by', then re-run 'nightcrew run'."
      echo ""
    fi
  done <<< "$task_ids"

  # Decision logs
  local repo_dir
  repo_dir=$(config_get "repo_path" "$(pwd)" "$config_file")
  local found_decisions=false

  while IFS= read -r task_id; do
    [[ -z "$task_id" ]] && continue

    # Check for DECISIONS files in the repo on the task branch
    local branch
    branch=$(jq -r ".tasks[\"$task_id\"].branch // \"\"" "$state_file" 2>/dev/null || true)

    # Check if decisions file exists in any worktree or was committed
    local decisions_file="$repo_dir/DECISIONS-${task_id}.md"
    if [[ -f "$decisions_file" ]]; then
      if [[ "$found_decisions" == "false" ]]; then
        echo "═══ DECISION LOGS ═══════════════════════════"
        found_decisions=true
      fi
      echo ""
      echo "── DECISIONS-${task_id}.md ──"
      cat "$decisions_file"
      echo ""
    fi
  done <<< "$task_ids"

  # Done sentinel
  if [[ -f "$NIGHTCREW_DIR/state/done" ]]; then
    echo "─────────────────────────────────────────────"
    echo "Session completed at: $(head -1 "$NIGHTCREW_DIR/state/done" | cut -d= -f2)"
  fi

  # Generate self-contained dashboard HTML with embedded data
  local dashboard_template="$NIGHTCREW_DIR/dashboard.html"
  local dashboard_output="$NIGHTCREW_DIR/state/dashboard.html"
  if [[ -f "$dashboard_template" ]]; then
    # Compact JSON to single line, escape for JS embedding
    local compact_json
    compact_json=$(jq -c '.' "$state_file" | sed 's|</script>|<\\/script>|g')
    # Use awk to replace the placeholder (handles special chars better than sed)
    awk -v data="$compact_json" '{
      gsub(/\/\*NIGHTCREW_DATA_PLACEHOLDER\*\/ null/, data)
      print
    }' "$dashboard_template" > "$dashboard_output"
    echo ""
    echo "Dashboard: file://$dashboard_output"
  fi
}
